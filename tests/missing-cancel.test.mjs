import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/sqlite-d1.mjs";
import { runMissingCancellations, renderMissingMessage, CANCEL_SETTINGS_KEY } from "../lib/missing-cancel-core.mjs";

async function fixture(t, marketplace="ozon") {
  const dir=mkdtempSync(join(tmpdir(),"missing-cancel-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=openDatabase(join(dir,"test.db"));
  await db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE pick_tasks(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE pick_task_items(id INTEGER PRIMARY KEY, task_id INTEGER,marketplace_id TEXT,external_order_id TEXT, external_sku TEXT,quantity INTEGER,status TEXT,article TEXT);
    CREATE TABLE shipment_labels(marketplace_id TEXT,external_order_id TEXT);
    CREATE TABLE ozon_label_jobs(posting_number TEXT);
    INSERT INTO pick_tasks VALUES(1,'issued'),(2,'issued');`);
  await db.exec(readFileSync(new URL("../drizzle/0035_missing_item_cancellations.sql",import.meta.url),"utf8"));
  await db.prepare("INSERT INTO settings VALUES(?,?)").bind(CANCEL_SETTINGS_KEY,JSON.stringify({text:"Нет {артикул}, количество {количество}. {промокод}",promo:"SORRY"})).run();
  await db.prepare("INSERT INTO pick_task_items VALUES(1,1,?,'ORDER-1','100',1,'not_found','К-1')").bind(marketplace).run();
  await db.prepare("INSERT INTO pick_task_items VALUES(2,2,?,'OTHER-ORDER','100',1,'picked','К-1')").bind(marketplace).run();
  await db.prepare("INSERT INTO missing_item_cancellations(item_id,task_id,marketplace_id,posting,sku,quantity,actor,created_at,updated_at) VALUES(1,1,?,'ORDER-1','100',1,'picker',1000,1000)").bind(marketplace).run();
  let time=1000, wbStatus="new";
  const posting={status:"awaiting_packaging",products:[{sku:100,quantity:2},{sku:200,quantity:1}]};
  const calls=[];
  const api={
    ozonPosting:async id=>{assert.equal(id,"ORDER-1");return structuredClone(posting);},
    ozonCheckReason:async()=>{},
    ozonChat:async id=>{calls.push(["chat",id]);return "CHAT";},
    ozonSend:async (chat,text)=>{calls.push(["message",chat,text,time]);},
    ozonCancel:async (id,sku,qty)=>{calls.push(["cancel",id,sku,qty,time]);posting.products.find(p=>String(p.sku)===sku).quantity-=qty;return id;},
    wbStatus:async id=>{assert.equal(id,"ORDER-1");return wbStatus;},
    wbCancel:async id=>{calls.push(["wbCancel",id]);wbStatus="cancel";},
  };
  const run=(extra={})=>runMissingCancellations(db,{...api,...extra},{now:()=>time,limit:10});
  const row=()=>db.prepare("SELECT * FROM missing_item_cancellations WHERE id=1").first();
  return {db,api,calls,posting,run,row,advance:ms=>{time+=ms;}};
}

test("Ozon cancels only one missing unit in one posting after 60 seconds; other SKU/order survives",async t=>{
  const f=await fixture(t);await f.run();
  assert.equal((await f.row()).state,"scheduled");
  assert.equal(f.calls.filter(c=>c[0]==="message").length,1);
  f.advance(59999);await f.run();assert.equal(f.calls.some(c=>c[0]==="cancel"),false);
  f.advance(1);await f.run();assert.deepEqual(f.calls.find(c=>c[0]==="cancel"),["cancel","ORDER-1","100",1,61000]);
  f.advance(5000);await f.run();assert.equal((await f.row()).state,"done");
  assert.deepEqual(f.posting.products,[{sku:100,quantity:1},{sku:200,quantity:1}]);
  assert.equal((await f.db.prepare("SELECT status FROM pick_task_items WHERE id=2").first()).status,"picked");
});

test("WB cancels the precise order without a message or delay",async t=>{
  const f=await fixture(t,"wildberries");await f.run();
  assert.deepEqual(f.calls,[["wbCancel","ORDER-1"]]);assert.equal((await f.row()).state,"done");
});

test("WB refuses whole-order cancellation if a sibling item exists",async t=>{
  const f=await fixture(t,"wildberries");
  await f.db.exec("INSERT INTO pick_task_items VALUES(3,1,'wildberries','ORDER-1','200',1,'picked','К-2')");
  await f.run();assert.equal(f.calls.length,0);assert.equal((await f.row()).state,"error");
});

test("missing message settings block Ozon cancellation, not the queue record",async t=>{
  const f=await fixture(t);await f.db.exec("DELETE FROM settings");await f.run();
  assert.equal((await f.row()).state,"error");assert.equal(f.calls.length,0);
});

test("failed message never starts cancellation timer",async t=>{
  const f=await fixture(t);await f.run({ozonSend:async()=>{throw Object.assign(new Error("Forbidden"),{definitive:true});}});
  assert.equal((await f.row()).state,"error");assert.equal((await f.row()).sent_at,null);
  f.advance(120000);await f.run();assert.equal(f.calls.some(c=>c[0]==="cancel"),false);
});

test("ambiguous message delivery is never retried automatically",async t=>{
  const f=await fixture(t);let sent=0;const override={ozonSend:async()=>{sent++;throw new Error("timeout");}};
  await f.run(override);await f.run(override);assert.equal(sent,1);assert.equal((await f.row()).state,"uncertain");
});

test("concurrent workers send a message exactly once",async t=>{
  const f=await fixture(t);await Promise.all([f.run(),f.run()]);
  assert.equal(f.calls.filter(c=>c[0]==="message").length,1);
});

test("changed remote composition during delay stops cancellation",async t=>{
  const f=await fixture(t);await f.run();f.posting.products[1].quantity=2;f.advance(60000);await f.run();
  assert.equal(f.calls.some(c=>c[0]==="cancel"),false);assert.equal((await f.row()).state,"error");
});

test("cancel timeout never subtracts the quantity a second time",async t=>{
  const f=await fixture(t);await f.run();f.advance(60000);let count=0;
  await f.run({ozonCancel:async()=>{count++;f.posting.products[0].quantity--;throw new Error("timeout");}});
  await f.run();assert.equal(count,1);assert.equal((await f.row()).state,"uncertain");
  await f.db.exec("UPDATE missing_item_cancellations SET state='verifying'");
  await f.run();assert.equal((await f.row()).state,"done");assert.equal(count,1);
});

test("a crash during sending requires manual review; scheduled jobs survive a restart",async t=>{
  const f=await fixture(t);await f.db.exec("UPDATE missing_item_cancellations SET state='sending'");
  f.advance(300001);await f.run();assert.equal((await f.row()).state,"uncertain");assert.equal(f.calls.length,0);
});

test("message rendering and configured promo are preserved",()=>{
  assert.equal(renderMissingMessage({text:"Нет {артикул}",promo:"CODE"},{article:"К-1",posting:"P",quantity:1}),"Нет К-1\nПромокод: CODE");
  assert.throws(()=>renderMissingMessage({text:"hello",promo:""},{}));
});

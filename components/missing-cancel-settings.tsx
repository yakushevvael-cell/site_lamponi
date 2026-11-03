"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { renderMissingMessage } from "@/lib/missing-cancel-core.mjs";

export function MissingCancelSettings() {
  const [text,setText]=useState("");
  const [promo,setPromo]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(true);
  useEffect(()=>{void fetch("/api/warehouse/missing-cancellations/settings").then(async response=>{
    const data=await response.json();
    if(!response.ok) throw new Error(data.error);
    setText(data.text??"");setPromo(data.promo??"");
  }).catch(error=>setNotice(error.message)).finally(()=>setBusy(false));},[]);
  let preview="";
  try {preview=renderMissingMessage({text,promo},{article:"К-123",quantity:1,posting:"12345678-0001-1"});} catch {}
  async function save(){
    setBusy(true);setNotice("");
    try {
      const response=await fetch("/api/warehouse/missing-cancellations/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,promo})});
      const data=await response.json();if(!response.ok)throw new Error(data.error);
      setNotice("Сохранено. Новый текст применяется к сообщениям, которые ещё не были подготовлены к отправке.");
    }catch(error){setNotice(error instanceof Error?error.message:"Не удалось сохранить.");}finally{setBusy(false);}
  }
  return <Card className="mx-auto my-6 max-w-5xl"><CardContent className="space-y-4 pt-6">
    <h2 className="text-lg font-semibold">Отмена отсутствующего изделия</h2>
    <p className="text-sm text-muted-foreground">«Не найден»: блокировка и обнуление остатков, отмена конкретного изделия. Для Ozon — сообщение покупателю, затем запрос частичной отмены через 60 секунд после подтверждённой отправки. Для WB — отмена сразу.</p>
    <p className="text-sm">Ozon требует Premium Plus или Premium Pro для сообщений. Без успешной отправки автоматическая отмена не выполняется.</p>
    <label className="block space-y-1"><span>Сообщение покупателю Ozon</span><textarea className="min-h-32 w-full rounded border p-3" value={text} onChange={e=>setText(e.target.value)} maxLength={1000}/></label>
    <p className="text-xs text-muted-foreground">Подстановки: {"{промокод}, {артикул}, {количество}, {заказ}"}. Если подстановки промокода нет, он добавится в конце сообщения.</p>
    <label className="block space-y-1"><span>Промокод</span><input className="w-full rounded border p-3" value={promo} onChange={e=>setPromo(e.target.value)} maxLength={100}/></label>
    <div className="whitespace-pre-wrap rounded bg-muted p-3 text-sm">{preview||"Заполните текст и промокод для предварительного просмотра."}</div>
    <Button disabled={busy||!preview} onClick={()=>void save()}>Сохранить сообщение</Button>
    {notice&&<p role="status" className="text-sm">{notice}</p>}
  </CardContent></Card>;
}

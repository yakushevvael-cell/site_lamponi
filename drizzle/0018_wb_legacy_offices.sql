-- Старые «офисы» WB (/api/v3/offices) больше не предлагаются как пункт отгрузки.
--
-- До миграции 0017 справочник заполнялся ими, и такой пункт остался в списке
-- выбора. Wildberries не принимает их ID в параметрах отгрузки поставки и
-- отвечает IncorrectRequestBody. Строки не удаляются — на них ссылаются уже
-- оформленные поставки, — а только выключаются.
UPDATE `dropoff_points` SET `active` = 0 WHERE `marketplace_id` = 'wildberries' AND `office_type` IS NULL;

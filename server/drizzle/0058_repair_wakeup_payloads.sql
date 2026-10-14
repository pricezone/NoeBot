-- Follow-ups settled before this fix had their payload turned into an array:
-- [original object, "{\"outcome\":...}"] (a JSON string appended rather than merged), which hid
-- them from every per-Bot listing and lost their outcome. Fold each such array back into one
-- object, later elements winning, exactly as the merge was meant to. Only arrays whose elements
-- are objects or JSON-object strings are touched.
UPDATE "work_items" AS w
SET "payload" = repaired.payload
FROM (
  SELECT wi."key",
    (
      SELECT jsonb_object_agg(kv.key, kv.value ORDER BY e.ord)
      FROM jsonb_array_elements(wi."payload") WITH ORDINALITY AS e(elem, ord),
      LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(e.elem) = 'string' THEN (e.elem #>> '{}')::jsonb
          ELSE e.elem
        END
      ) AS kv
    ) AS payload
  FROM "work_items" AS wi
  WHERE wi."kind" = 'bot.wakeup'
    AND jsonb_typeof(wi."payload") = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(wi."payload") AS x(elem)
      WHERE NOT (
        jsonb_typeof(x.elem) = 'object'
        OR (jsonb_typeof(x.elem) = 'string' AND (x.elem #>> '{}') ~ '^\s*\{.*\}\s*$')
      )
    )
) AS repaired
WHERE w."key" = repaired."key" AND w."kind" = 'bot.wakeup' AND repaired.payload IS NOT NULL;

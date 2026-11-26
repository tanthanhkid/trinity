SELECT line FROM (
  SELECT 1 AS sec, format('column %s #%s %s %s%s null=%s default=%s', c.table_name, c.ordinal_position, c.column_name,
           c.data_type, coalesce('(' || c.character_maximum_length || ')', ''), c.is_nullable, coalesce(c.column_default, '-')) AS line
    FROM information_schema.columns c WHERE c.table_schema = 'platform'
  UNION ALL
  SELECT 2, format('constraint %s %s %s', co.conrelid::regclass, co.conname, pg_get_constraintdef(co.oid))
    FROM pg_constraint co WHERE co.connamespace = 'platform'::regnamespace
  UNION ALL
  SELECT 3, format('index %s', i.indexdef) FROM pg_indexes i WHERE i.schemaname = 'platform'
  UNION ALL
  SELECT 4, format('sequence %s.%s %s', s.schemaname, s.sequencename, s.data_type) FROM pg_sequences s WHERE s.schemaname = 'platform'
  UNION ALL
  SELECT 5, format('function %s comment=%s%s%s', p.oid::regprocedure, coalesce(obj_description(p.oid, 'pg_proc'), '-'), E'\n',
           pg_get_functiondef(p.oid))
    FROM pg_proc p WHERE p.proname LIKE 'trinity\_platform\_sync\_%' OR p.proname = 'trinity_single_user'
  UNION ALL
  SELECT 6, format('trigger %s', pg_get_triggerdef(t.oid)) FROM pg_trigger t
    WHERE NOT t.tgisinternal AND (t.tgname LIKE 'trinity\_platform\_sync\_%' OR t.tgname = 'trinity_single_user')
  UNION ALL
  SELECT 7, format('company %s %s %s %s migrated_to=%s locked=%s reason=%s locked_at=%s', id, name, schema_name, status,
           coalesce(migrated_to, '-'), channels_locked, coalesce(channels_lock_reason, '-'), channels_locked_at IS NOT NULL)
    FROM platform.companies
  UNION ALL
  SELECT 8, format('login %s %s', email, company_id) FROM platform.company_logins
  UNION ALL
  SELECT 9, format('route %s %s %s', kind, external_id, company_id) FROM platform.company_routes
) x ORDER BY sec, line COLLATE "C"

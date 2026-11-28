-- Enable Supabase Realtime on instant_test_attempts so student screens
-- receive cheating termination updates immediately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'instant_test_attempts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.instant_test_attempts;
  END IF;
END
$$;

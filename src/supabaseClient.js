// src/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

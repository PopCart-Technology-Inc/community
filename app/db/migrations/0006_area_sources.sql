-- Where each country's area list came from (decision 0005). The app credits the publisher wherever
-- place names are shown, and shows the edition and the import time so a stale list is visible.
CREATE TABLE area_sources (
  country_code text PRIMARY KEY,
  publisher    text NOT NULL,
  dataset      text NOT NULL,
  edition      text,
  url          text NOT NULL,
  areas        integer NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now()
);

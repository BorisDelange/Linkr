# Length-of-stay summary by ICU unit.
# Run from the project workspace where icu-stays.csv lives.

library(dplyr)

stays <- read.csv("icu-stays.csv")

summary_by_unit <- stays %>%
  group_by(icu_unit) %>%
  summarise(
    n = n(),
    median_los = median(los_days),
    ventilated_pct = mean(mechanical_ventilation) * 100,
    .groups = "drop"
  ) %>%
  arrange(desc(median_los))

print(summary_by_unit)

# =============================================================================
# 05_example.R — Example R script
#
# This is a standalone example of an R script in Linkr.
# It demonstrates descriptive statistics, logistic regression,
# and ROC curve evaluation using base R.
#
# sql_query(sql) is automatically available in Linkr.
# It queries the active DuckDB connection and returns a data.frame.
# Usage: df <- sql_query("SELECT * FROM person LIMIT 10")
#
# Topic: Statistical analysis for ICU mortality prediction
# Output: Console output + plots
# =============================================================================

# ---------------------------------------------------------------------------
# 1. Create cohort views and extract data
# ---------------------------------------------------------------------------
sql_query("
    CREATE OR REPLACE VIEW eligible_visits AS
    SELECT
        v.visit_occurrence_id, v.person_id,
        v.visit_start_date,
        v.visit_start_datetime::TIMESTAMP AS visit_start_datetime,
        v.visit_end_date,
        v.visit_end_datetime::TIMESTAMP AS visit_end_datetime,
        EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP
            - v.visit_start_datetime::TIMESTAMP)) / 86400.0 AS los_days
    FROM visit_occurrence v
    WHERE EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP
        - v.visit_start_datetime::TIMESTAMP)) / 86400.0 >= 1
")

sql_query("
    CREATE OR REPLACE VIEW visit_mortality AS
    SELECT ev.*,
        CASE WHEN d.death_date IS NOT NULL
             AND d.death_date BETWEEN ev.visit_start_date
                                   AND ev.visit_end_date + INTERVAL '1 day'
             THEN 1 ELSE 0 END AS in_hospital_death
    FROM eligible_visits ev
    LEFT JOIN death d ON ev.person_id = d.person_id
")

sql_query("
    CREATE OR REPLACE VIEW cohort AS
    SELECT vm.visit_occurrence_id, vm.person_id, vm.visit_start_datetime,
        EXTRACT(YEAR FROM vm.visit_start_date) - p.year_of_birth AS age,
        p.gender_source_value AS sex, vm.los_days, vm.in_hospital_death
    FROM visit_mortality vm
    JOIN person p ON vm.person_id = p.person_id
    WHERE EXISTS (
        SELECT 1 FROM measurement m
        WHERE m.visit_occurrence_id = vm.visit_occurrence_id
          AND m.value_as_number IS NOT NULL
          AND m.measurement_datetime::TIMESTAMP >= vm.visit_start_datetime
          AND m.measurement_datetime::TIMESTAMP
              <= vm.visit_start_datetime + INTERVAL '24 hours'
    )
")

# ---------------------------------------------------------------------------
# 2. Feature engineering: extract H0-H24 measurements
# ---------------------------------------------------------------------------
vitals_ids   <- c(3027018, 3004249, 3012888, 3027598, 3024171, 40762499, 3020891)
labs_ids     <- c(3000963, 3023314, 3024929, 3003282, 3019550, 3023103,
                  3014576, 3016293, 3016723, 3013682, 3004501, 3037278,
                  3015377, 3012095, 3011904)
neuro_ids    <- c(3016335, 3009094, 3008223)
all_ids      <- c(vitals_ids, labs_ids, neuro_ids)
all_names    <- c(
    "hr", "sbp", "dbp", "mbp", "resp_rate", "spo2", "temp",
    "hemoglobin", "hematocrit", "platelets", "wbc", "sodium", "potassium",
    "chloride", "bicarbonate", "creatinine", "bun", "glucose", "anion_gap",
    "calcium", "magnesium", "phosphate",
    "gcs_eye", "gcs_verbal", "gcs_motor"
)
names(all_names) <- as.character(all_ids)

concept_csv <- paste(all_ids, collapse = ", ")
measurements_h24 <- sql_query(paste0("
    SELECT m.visit_occurrence_id, m.measurement_concept_id,
           m.value_as_number,
           m.measurement_datetime::TIMESTAMP AS measurement_datetime,
           c.visit_start_datetime
    FROM measurement m
    JOIN cohort c ON m.visit_occurrence_id = c.visit_occurrence_id
    WHERE m.measurement_concept_id IN (", concept_csv, ")
      AND m.value_as_number IS NOT NULL
      AND m.measurement_datetime::TIMESTAMP >= c.visit_start_datetime
      AND m.measurement_datetime::TIMESTAMP
          <= c.visit_start_datetime + INTERVAL '24 hours'
"))

cat(sprintf("Measurements in H0-H24: %d rows\n", nrow(measurements_h24)))

# Map concept IDs to feature names
measurements_h24$feature <- all_names[as.character(measurements_h24$measurement_concept_id)]

# Aggregate per visit x feature
agg_list <- list()
for (vid in unique(measurements_h24$visit_occurrence_id)) {
    sub <- measurements_h24[measurements_h24$visit_occurrence_id == vid, ]
    for (feat in unique(sub$feature)) {
        rows <- sub[sub$feature == feat, ]
        cid <- rows$measurement_concept_id[1]
        vals <- rows$value_as_number[order(rows$measurement_datetime)]

        if (cid %in% vitals_ids) {
            agg_list[[length(agg_list) + 1]] <- data.frame(
                visit_occurrence_id = vid,
                col = paste0(feat, c("_mean", "_min", "_max")),
                val = c(mean(vals), min(vals), max(vals)),
                stringsAsFactors = FALSE)
        } else if (cid %in% neuro_ids) {
            agg_list[[length(agg_list) + 1]] <- data.frame(
                visit_occurrence_id = vid,
                col = paste0(feat, "_min"), val = min(vals),
                stringsAsFactors = FALSE)
        } else if (cid %in% labs_ids) {
            agg_list[[length(agg_list) + 1]] <- data.frame(
                visit_occurrence_id = vid,
                col = paste0(feat, "_first"), val = vals[1],
                stringsAsFactors = FALSE)
        }
    }
}
agg_df <- do.call(rbind, agg_list)

# Pivot to wide format
wide <- reshape(agg_df, idvar = "visit_occurrence_id", timevar = "col",
                direction = "wide", v.names = "val")
names(wide) <- sub("^val\\.", "", names(wide))

# Merge with cohort demographics
cohort_df <- sql_query("
    SELECT visit_occurrence_id, person_id, age, sex, los_days, in_hospital_death
    FROM cohort
")
df <- merge(cohort_df, wide, by = "visit_occurrence_id", all.x = TRUE)

cat(sprintf("Dataset: %d rows x %d columns\n", nrow(df), ncol(df)))
cat(sprintf("Mortality: %d / %d (%.1f%%)\n\n",
    sum(df$in_hospital_death), nrow(df),
    100 * mean(df$in_hospital_death)))

# ---------------------------------------------------------------------------
# 3. Descriptive statistics (Table 1)
# ---------------------------------------------------------------------------
cat("=" |> rep(60) |> paste(collapse = ""), "\n")
cat("TABLE 1: Patient characteristics by outcome\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n\n")

alive <- df[df$in_hospital_death == 0, ]
dead  <- df[df$in_hospital_death == 1, ]

describe_continuous <- function(var_name, label = var_name) {
  a <- alive[[var_name]]
  d <- dead[[var_name]]
  a <- a[!is.na(a)]
  d <- d[!is.na(d)]
  cat(sprintf("%-25s  Alive: %.1f (%.1f)  |  Dead: %.1f (%.1f)  |  p=%.3f\n",
      label,
      mean(a), sd(a),
      mean(d), sd(d),
      tryCatch(wilcox.test(a, d)$p.value, error = function(e) NA)))
}

describe_categorical <- function(var_name, label = var_name) {
  tbl <- table(df[[var_name]], df$in_hospital_death)
  cat(sprintf("%-25s  %s  |  p=%.3f\n",
      label,
      paste(sprintf("%s: %d/%d", rownames(tbl), tbl[, 1], tbl[, 2]), collapse = "  "),
      tryCatch(fisher.test(tbl)$p.value, error = function(e) NA)))
}

cat("Demographics:\n")
describe_continuous("age", "Age (years)")
describe_categorical("sex", "Sex")
describe_continuous("los_days", "Length of stay (days)")

cat("\nVitals (first 24h):\n")
for (v in c("hr", "sbp", "dbp", "resp_rate", "spo2", "temp")) {
  col <- paste0(v, "_mean")
  if (col %in% names(df)) describe_continuous(col, paste0(v, " (mean)"))
}

cat("\nLaboratory (first value):\n")
for (v in c("hemoglobin", "creatinine", "potassium", "sodium", "glucose",
            "bun", "wbc", "platelets", "bicarbonate", "anion_gap")) {
  col <- paste0(v, "_first")
  if (col %in% names(df)) describe_continuous(col, v)
}

cat("\nGlasgow Coma Scale (worst in 24h):\n")
for (v in c("gcs_eye_min", "gcs_verbal_min", "gcs_motor_min")) {
  if (v %in% names(df)) describe_continuous(v, gsub("_min", "", v))
}

# ---------------------------------------------------------------------------
# 4. Logistic regression model
# ---------------------------------------------------------------------------
cat("\n\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n")
cat("LOGISTIC REGRESSION: In-hospital mortality\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n\n")

# Select features with < 30% missing values
feature_cols <- setdiff(names(df), c("visit_occurrence_id", "person_id",
                                      "sex", "los_days", "in_hospital_death"))
missing_pct <- sapply(df[feature_cols], function(x) mean(is.na(x)))
selected_features <- names(missing_pct[missing_pct < 0.30])

cat(sprintf("Features with <30%% missing: %d / %d\n", length(selected_features), length(feature_cols)))
cat(sprintf("Selected: %s\n\n", paste(selected_features, collapse = ", ")))

# Prepare model data: impute missing with median, encode sex
model_df <- df[, c("in_hospital_death", "sex", selected_features)]
model_df$sex_male <- as.integer(model_df$sex == "M")
model_df$sex <- NULL

# Median imputation for remaining NAs
for (col in selected_features) {
  nas <- is.na(model_df[[col]])
  if (any(nas)) {
    model_df[[col]][nas] <- median(model_df[[col]], na.rm = TRUE)
  }
}

# Fit model
formula <- as.formula(paste("in_hospital_death ~",
    paste(c("sex_male", selected_features), collapse = " + ")))
model <- glm(formula, data = model_df, family = binomial)

cat("Model summary:\n")
print(summary(model))

# ---------------------------------------------------------------------------
# 5. Model evaluation
# ---------------------------------------------------------------------------
cat("\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n")
cat("MODEL EVALUATION\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n\n")

# Predicted probabilities
pred_prob <- predict(model, type = "response")

# ROC curve (manual — no external packages needed)
thresholds <- seq(0, 1, by = 0.01)
roc_data <- data.frame(
  threshold = thresholds,
  tpr = sapply(thresholds, function(t) {
    pred <- as.integer(pred_prob >= t)
    sum(pred == 1 & model_df$in_hospital_death == 1) /
      max(sum(model_df$in_hospital_death == 1), 1)
  }),
  fpr = sapply(thresholds, function(t) {
    pred <- as.integer(pred_prob >= t)
    sum(pred == 1 & model_df$in_hospital_death == 0) /
      max(sum(model_df$in_hospital_death == 0), 1)
  })
)

# AUC (trapezoidal rule)
roc_sorted <- roc_data[order(roc_data$fpr, roc_data$tpr), ]
auc <- sum(diff(roc_sorted$fpr) * (head(roc_sorted$tpr, -1) + tail(roc_sorted$tpr, -1)) / 2)
auc <- abs(auc)
cat(sprintf("AUC-ROC: %.3f\n", auc))

# Confusion matrix at threshold 0.5
pred_class <- as.integer(pred_prob >= 0.5)
cm <- table(Predicted = pred_class, Actual = model_df$in_hospital_death)
cat("\nConfusion matrix (threshold = 0.5):\n")
print(cm)

accuracy  <- sum(diag(cm)) / sum(cm)
sens <- if (sum(model_df$in_hospital_death == 1) > 0)
  cm["1", "1"] / sum(cm[, "1"]) else NA
spec <- if (sum(model_df$in_hospital_death == 0) > 0)
  cm["0", "0"] / sum(cm[, "0"]) else NA

cat(sprintf("\nAccuracy:    %.1f%%\n", 100 * accuracy))
cat(sprintf("Sensitivity: %.1f%%\n", 100 * sens))
cat(sprintf("Specificity: %.1f%%\n", 100 * spec))

# ---------------------------------------------------------------------------
# 6. Plot ROC curve
# ---------------------------------------------------------------------------
plot(roc_sorted$fpr, roc_sorted$tpr,
     type = "l", col = "steelblue", lwd = 2,
     xlab = "False Positive Rate (1 - Specificity)",
     ylab = "True Positive Rate (Sensitivity)",
     main = sprintf("ROC Curve — In-hospital Mortality (AUC = %.3f)", auc))
abline(0, 1, lty = 2, col = "gray50")
legend("bottomright", legend = sprintf("AUC = %.3f", auc),
       col = "steelblue", lwd = 2)

cat("\nDone.\n")

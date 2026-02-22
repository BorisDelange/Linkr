# =============================================================================
# 03_analysis.R
# Mortality prediction project — Step 3: Statistical analysis
#
# Reads the wide-format dataset produced by 02_feature_engineering.py,
# performs descriptive statistics, fits a logistic regression model,
# and evaluates its performance (ROC curve, confusion matrix).
#
# Input:  data/datasets/mortality_dataset.csv
# Output: Console output + plots
# =============================================================================

# ---------------------------------------------------------------------------
# 1. Load data
# ---------------------------------------------------------------------------
df <- read.csv("data/datasets/mortality_dataset.csv", stringsAsFactors = FALSE)
cat(sprintf("Dataset loaded: %d rows x %d columns\n", nrow(df), ncol(df)))
cat(sprintf("Mortality: %d / %d (%.1f%%)\n\n",
    sum(df$in_hospital_death), nrow(df),
    100 * mean(df$in_hospital_death)))

# ---------------------------------------------------------------------------
# 2. Descriptive statistics (Table 1)
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
describe_continuous("los_hours", "Length of stay (h)")

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
# 3. Logistic regression model
# ---------------------------------------------------------------------------
cat("\n\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n")
cat("LOGISTIC REGRESSION: In-hospital mortality\n")
cat("=" |> rep(60) |> paste(collapse = ""), "\n\n")

# Select features with < 30% missing values
feature_cols <- setdiff(names(df), c("visit_occurrence_id", "person_id",
                                      "sex", "los_hours", "in_hospital_death"))
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
# 4. Model evaluation
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
# 5. Plot ROC curve
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

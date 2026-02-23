# Plugin Reference Examples

## Types

The core types are defined in `apps/web/src/types/plugin.ts`:

- `PluginManifest` — JSON manifest with id, name, description, version, scope, configSchema, etc.
- `Plugin` — resolved plugin with manifest + loaded template strings
- `PluginConfigField` — schema for a single config field (type, label, default, min, max, options)

## configSchema field types

### boolean
```json
"showGrid": {
  "type": "boolean",
  "label": { "en": "Show grid", "fr": "Afficher la grille" },
  "default": true
}
```
Template: `show_grid = {{showGrid}}` → Python: `show_grid = True`, R: `show_grid <- TRUE`

### number
```json
"bins": {
  "type": "number",
  "label": { "en": "Histogram bins", "fr": "Nombre de barres" },
  "default": 15,
  "min": 5,
  "max": 100
}
```
Template: `bins = {{bins}}` → `bins = 15`

### select
```json
"interpolation": {
  "type": "select",
  "label": { "en": "Interpolation", "fr": "Interpolation" },
  "default": "linear",
  "options": [
    { "value": "linear", "label": { "en": "Linear", "fr": "Linéaire" } },
    { "value": "step", "label": { "en": "Step", "fr": "Escalier" } }
  ]
}
```
Template: `interpolation = {{interpolation}}` → Python: `interpolation = "linear"`, R: `interpolation <- "linear"`
**IMPORTANT**: Do NOT wrap `{{interpolation}}` in quotes — the resolver adds them automatically.

### string
```json
"title": {
  "type": "string",
  "label": { "en": "Chart title", "fr": "Titre du graphique" },
  "default": ""
}
```
Template: `title = {{title}}` → Python: `title = "My chart"`, R: `title <- "My chart"`

### column-select
```json
"selectedColumns": {
  "type": "column-select",
  "multi": true,
  "label": { "en": "Variables", "fr": "Variables" },
  "defaultAll": true,
  "filter": "numeric"
}
```
Template: `columns = {{selectedColumns}}` → Python: `columns = ["age", "weight"]`, R: `columns <- c("age", "weight")`

---

## Example 1: Lab plugin — Distribution

**plugin.json:**
```json
{
  "id": "linkr-analysis-distribution",
  "name": { "en": "Distribution", "fr": "Distribution" },
  "description": {
    "en": "Histograms for numeric variables and frequency bar charts for categorical variables.",
    "fr": "Histogrammes pour les variables numériques et diagrammes de fréquences pour les catégorielles."
  },
  "version": "1.0.0",
  "category": "analysis",
  "tags": ["descriptive", "chart", "histogram"],
  "runtime": ["script"],
  "languages": ["python", "r"],
  "icon": "BarChart3",
  "configSchema": {
    "selectedColumns": {
      "type": "column-select",
      "multi": true,
      "label": { "en": "Variables", "fr": "Variables" },
      "defaultAll": true
    },
    "bins": {
      "type": "number",
      "label": { "en": "Histogram bins", "fr": "Nombre de barres" },
      "default": 15,
      "min": 5,
      "max": 100
    },
    "maxCategories": {
      "type": "number",
      "label": { "en": "Max categories shown", "fr": "Catégories max affichées" },
      "default": 20,
      "min": 5,
      "max": 100
    }
  },
  "dependencies": { "python": [], "r": [] },
  "templates": {
    "python": "distribution.py.template",
    "r": "distribution.R.template"
  }
}
```

**distribution.py.template:**
```python
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# 'dataset' is a pandas DataFrame injected automatically.
columns = {{selectedColumns}}
bins = {{bins}}
max_categories = {{maxCategories}}

for col in columns:
    if col not in dataset.columns:
        continue
    series = dataset[col].dropna()
    if len(series) == 0:
        continue
    numeric_series = pd.to_numeric(series, errors='coerce').dropna()
    if len(numeric_series) > 0 and len(numeric_series) / len(series) > 0.5:
        fig, ax = plt.subplots(figsize=(8, 4))
        ax.hist(numeric_series, bins=bins, edgecolor='white', alpha=0.8)
        ax.set_title(col)
        plt.tight_layout()
    else:
        counts = series.value_counts().head(max_categories)
        fig, ax = plt.subplots(figsize=(8, max(3, len(counts) * 0.35)))
        ax.barh(range(len(counts)), counts.values, alpha=0.8)
        ax.set_yticks(range(len(counts)))
        ax.set_yticklabels(counts.index, fontsize=9)
        ax.set_title(col)
        ax.invert_yaxis()
        plt.tight_layout()

if not columns:
    print("No columns selected.")
```

**distribution.R.template:**
```r
library(graphics)

# 'dataset' is a data.frame injected automatically.
columns <- {{selectedColumns}}
bins <- {{bins}}
max_categories <- {{maxCategories}}

valid_cols <- columns[columns %in% colnames(dataset)]

for (col in valid_cols) {
  x <- dataset[[col]]
  x_clean <- x[!is.na(x)]
  if (length(x_clean) == 0) next
  x_num <- suppressWarnings(as.numeric(x_clean))
  n_valid <- sum(!is.na(x_num))
  if (n_valid > 0 && n_valid / length(x_clean) > 0.5) {
    x_num <- x_num[!is.na(x_num)]
    par(mfrow = c(1, 1), mar = c(4, 4, 3, 1))
    hist(x_num, breaks = bins, main = col, xlab = col, ylab = "Count",
         col = rgb(0.4, 0.6, 0.9, 0.7), border = "white")
  } else {
    counts <- sort(table(x_clean), decreasing = TRUE)
    counts <- head(counts, max_categories)
    if (length(counts) == 0) next
    par(mfrow = c(1, 1), mar = c(4, max(nchar(names(counts))) * 0.5 + 2, 3, 1))
    barplot(rev(counts), horiz = TRUE, main = col,
            xlab = "Count", las = 1, cex.names = 0.8,
            col = rgb(0.4, 0.6, 0.9, 0.7), border = "white")
  }
}
```

---

## Example 2: Warehouse plugin — Timeline (with needsConceptPicker)

**plugin.json:**
```json
{
  "id": "linkr-warehouse-timeline",
  "name": { "en": "Timeline", "fr": "Chronologie" },
  "description": {
    "en": "Line chart of numeric measurements over time, with optional unit stay bars and hospitalization boundaries.",
    "fr": "Courbe de mesures numériques dans le temps, avec barres de séjours en unité et bornes d'hospitalisation optionnelles."
  },
  "version": "1.0.0",
  "scope": "warehouse",
  "category": "visualization",
  "tags": ["timeline", "chart", "measurements"],
  "runtime": ["script"],
  "languages": ["python", "r"],
  "icon": "TrendingUp",
  "iconColor": "blue",
  "needsConceptPicker": true,
  "configSchema": {
    "showUnitStays": {
      "type": "boolean",
      "label": { "en": "Show unit stay bars", "fr": "Afficher les barres de séjours en unité" },
      "default": true
    },
    "showVisitBounds": {
      "type": "boolean",
      "label": { "en": "Show hospitalization boundaries", "fr": "Afficher les bornes d'hospitalisation" },
      "default": false
    },
    "pointSize": {
      "type": "number",
      "label": { "en": "Point size", "fr": "Taille des points" },
      "default": 3,
      "min": 1,
      "max": 10
    },
    "interpolation": {
      "type": "select",
      "label": { "en": "Interpolation", "fr": "Interpolation" },
      "default": "linear",
      "options": [
        { "value": "linear", "label": { "en": "Linear", "fr": "Linéaire" } },
        { "value": "step", "label": { "en": "Step", "fr": "Escalier" } }
      ]
    }
  },
  "dependencies": { "python": ["matplotlib"], "r": [] },
  "templates": {
    "python": "timeline.py.template",
    "r": "timeline.R.template"
  }
}
```

**timeline.py.template:**
```python
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

# Pre-injected: person_id, visit_occurrence_id, visit_detail_id
# Pre-injected: timeline_sql, visit_summary_sql

show_unit_stays = {{showUnitStays}}
show_visit_bounds = {{showVisitBounds}}
point_size = {{pointSize}}
interpolation = {{interpolation}}

if not timeline_sql:
    print("No concepts selected. Use the Edit button to select concepts.")
else:
    df = await sql_query(timeline_sql)
    if df.empty:
        print("No data found for the selected concepts and patient.")
    else:
        df['event_date'] = pd.to_datetime(df['event_date'], utc=True)
        df = df.sort_values('event_date')
        concepts = df['concept_name'].unique()
        colors = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
                  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab']

        fig, ax = plt.subplots(figsize=(10, 4))

        # Unit stay background bars
        if show_unit_stays and visit_summary_sql:
            vd = await sql_query(visit_summary_sql)
            if not vd.empty:
                details = vd[vd['row_type'] == 'visit_detail'].copy()
                details['start_date'] = pd.to_datetime(details['start_date'], utc=True)
                details['end_date'] = pd.to_datetime(details['end_date'], utc=True)
                units = details['unit'].dropna().unique()
                unit_colors = ['#e8f0fe', '#fef3e0', '#fce8e8', '#e8f5f0', '#f0e8fe']
                for j, unit in enumerate(units):
                    rows = details[details['unit'] == unit]
                    c = unit_colors[j % len(unit_colors)]
                    for _, r in rows.iterrows():
                        ax.axvspan(r['start_date'], r['end_date'], alpha=0.25, color=c, zorder=0)

        # Visit boundary lines
        if show_visit_bounds and visit_summary_sql:
            if 'vd' not in dir():
                vd = await sql_query(visit_summary_sql)
            if not vd.empty:
                visits = vd[vd['row_type'] == 'visit'].copy()
                visits['start_date'] = pd.to_datetime(visits['start_date'], utc=True)
                visits['end_date'] = pd.to_datetime(visits['end_date'], utc=True)
                for _, r in visits.iterrows():
                    ax.axvline(r['start_date'], color='#999', linestyle='--', linewidth=0.7, zorder=1)

        # Plot measurement series
        drawstyle = 'steps-post' if interpolation == 'step' else 'default'
        for i, concept in enumerate(concepts):
            sub = df[df['concept_name'] == concept].sort_values('event_date')
            color = colors[i % len(colors)]
            ax.plot(sub['event_date'], sub['value'], 'o-',
                    label=concept, color=color, markersize=point_size,
                    drawstyle=drawstyle, linewidth=1, zorder=2)

        ax.legend(fontsize=7, loc='upper left', framealpha=0.8)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
        fig.autofmt_xdate(rotation=30, ha='right')
        ax.grid(True, alpha=0.2)
        plt.tight_layout()
        plt.show()
```

**timeline.R.template:**
```r
library(graphics)

# Pre-injected: person_id, visit_occurrence_id, visit_detail_id
# Pre-injected: timeline_sql, visit_summary_sql

show_unit_stays <- {{showUnitStays}}
show_visit_bounds <- {{showVisitBounds}}
point_size <- {{pointSize}}
interpolation <- {{interpolation}}

if (is.null(timeline_sql) || timeline_sql == "") {
  cat("No concepts selected. Use the Edit button to select concepts.\n")
} else {
  df <- sql_query(timeline_sql)
  if (is.null(df) || nrow(df) == 0) {
    cat("No data found for the selected concepts and patient.\n")
  } else {
    df$event_date <- as.POSIXct(df$event_date, tz = "UTC")
    df$value <- as.numeric(df$value)
    df <- df[order(df$event_date), ]
    concepts <- unique(df$concept_name)
    colors <- c("#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
                "#edc949", "#af7aa1", "#ff9da7", "#9c755f", "#bab0ab")

    date_range <- range(df$event_date, na.rm = TRUE)
    val_range <- range(df$value, na.rm = TRUE)
    val_pad <- diff(val_range) * 0.05
    if (val_pad == 0) val_pad <- 1

    par(mar = c(5, 4, 2, 1))
    plot(date_range, val_range + c(-val_pad, val_pad),
         type = "n", xlab = "", ylab = "", xaxt = "n", main = "")
    axis.POSIXct(1, at = pretty(date_range, n = 6), format = "%Y-%m-%d",
                 las = 2, cex.axis = 0.7)

    for (i in seq_along(concepts)) {
      sub <- df[df$concept_name == concepts[i], ]
      sub <- sub[order(sub$event_date), ]
      color <- colors[(i - 1) %% length(colors) + 1]
      line_type <- if (interpolation == "step") "s" else "o"
      lines(sub$event_date, sub$value, type = line_type,
            col = color, pch = 16, cex = point_size * 0.3, lwd = 1)
    }

    legend("topleft", legend = concepts,
           col = colors[seq_along(concepts)],
           lty = 1, pch = 16, cex = 0.7, bg = "white")
    grid(col = adjustcolor("gray", alpha.f = 0.2))
  }
}
```

---

## Registration pattern

In `apps/web/src/lib/plugins/default-plugins.ts`:

```typescript
// Import manifest
import myPluginManifest from '@default-plugins/analyses/my-plugin/plugin.json'
// Import templates
import myPluginPy from '@default-plugins/analyses/my-plugin/my-plugin.py.template?raw'
import myPluginR from '@default-plugins/analyses/my-plugin/my-plugin.R.template?raw'

// In registerDefaultPlugins():
registerPlugin(
  buildPlugin(myPluginManifest as unknown as Record<string, unknown>, { python: myPluginPy, r: myPluginR }),
)
```

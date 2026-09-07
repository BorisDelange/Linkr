## Introduction

Draws one patient's measurements against time: heart rate over a stay, three
consecutive lactates, a ventilator setting held for two days. You pick the
concepts, the widget finds every recorded value for that patient and plots them
on a shared time axis you can zoom and pan.

This is a per-patient widget, not a cohort analysis. It reads the warehouse's
OMOP event tables (measurement, observation, drug and device exposures,
procedures, specimens) for the one patient whose chart is open, matching both the
standard concept id and the source concept id, so a locally coded value still
appears. When a visit is selected in the sidebar, only that visit's events are
plotted.

![Two Timeline widgets on a patient chart: blood-pressure curves above, and a
norepinephrine infusion drawn as bars below, with a tooltip giving the dose and
the duration.](attachments/output.png)

Above: two widgets on the same board. The upper one is in *Curves* mode, the
lower in *Mixed shapes* — the infusion has a start and an end, so it is drawn as
a bar with the dose and duration in its tooltip. Both show the same hours because
**Sync time range** is on.

## Settings

**Concepts** is the only one that must be filled. Pick from the concept picker;
each concept becomes one series.

**Renderer** decides the shape of the chart:

- *Curves* draws a classic line chart, for continuous numeric measurements.
- *Mixed shapes* gives each concept its own horizontal lane and draws each event
  as the shape it deserves: a bar for anything with a start and an end (an
  infusion, a stay in a bed), a line with dots for a repeated numeric value, a
  single dot for a categorical or one-off event.
- *Automatic*, the default, uses curves while every selected concept is a
  continuous numeric measurement, and switches to mixed shapes as soon as one is
  categorical or has a duration.

**Show points** (on by default) draws a marker at each recorded value. Turn it
off for dense monitor series, where thousands of markers merge into a blob.

**Step plot** holds each value constant until the next one instead of
interpolating between them — the rendering that matches anything set rather than
measured: a ventilator mode, a PEEP, a pump rate, a prescribed dose.

**Y axis starts at zero** forces the axis to include zero. Off by default, so the
axis fits the data.

**Line thickness** takes 0.5–3 px. Thin keeps dense series from merging; thick
reads better on a projector.

**Sync time range** ties this chart's visible window to the other synced widgets
on the board.

## Notes on the widget

### One shared y axis in Curves mode

In *Curves* mode every selected concept is drawn against a **single** value axis.
There is no second axis and no normalisation, so the axis spans from the smallest
value across all your series to the largest.

Concepts on different scales are therefore unreadable together: a heart rate
(60–130) plotted with a platelet count (50 000–300 000) collapses to a flat line
at the bottom. There is no setting for this — use a second widget, put the series
that share an order of magnitude on each, and turn **Sync time range** on for
both so they read as one stacked chart.

Units appear in the tooltip, never on the axis, and only when a concept has
exactly one unit in this patient's record. A concept recorded in two units shows
no unit at all rather than labelling everything with the first.

### Sync time range, and how far it reaches

With **Sync time range** on, this widget shares its visible window with the other
synced widgets on the board — other timelines and Data overview widgets alike.
Zoom into a six-hour episode on one and every synced chart follows.

Board settings decide the reach: by default sharing stops at the tab the widgets
are on, and a board-level option widens it to every tab. Sharing is always scoped
to the board, so two boards open on two patients never pull each other's windows
around. Switching patient releases the shared window rather than carrying it
over.

### What the chart draws that the record does not contain

> [!WARNING]
> **Between two points, the line is drawn by the chart, not measured on the
> patient.** With **Step plot** off, consecutive values are joined by a straight
> segment; with it on, by a staircase. Both are renderings, not data. On sparse
> series — a lactate twice a day, a value that exists only when someone drew the
> gas — keep **Show points** on so the markers say where the evidence actually
> is, and do not read a value off the line at a time where no point sits.

The same caution applies to the axis. With **Y axis starts at zero** off, the
axis fits the data, so a variable that moved three units fills the plot; with it
on, a real change can be flattened into a bump, and for variables whose range
sits far from zero the whole series is squeezed into the top of the plot. Read
the axis labels before reading the shape.

## A worked example

*Plotting haemodynamics and the drugs running underneath them.*

One patient's chart, ICU stay selected in the sidebar.

1. **Concepts** → mean arterial pressure, heart rate. Same order of magnitude, so
   one axis is legible.
2. **Renderer** → *Automatic*; both are continuous numerics, so it draws curves.
3. **Show points** → on, **Step plot** → off. These are measured values, not held
   settings.
4. **Y axis starts at zero** → off, so the range the question is about is not
   compressed.
5. **Sync time range** → on.

Then add a second Timeline widget on the same board, with the vasopressor and the
antibiotic as **Concepts** and **Renderer** on *Mixed shapes* — the infusion is a
duration and gets a bar, the antibiotic administration a dot — and **Sync time
range** on. Zoom either chart and both follow.

If a series you expect is missing, check the concept picker first: the widget
matches standard *and* source concept ids, but a concept never mapped in this
warehouse has nothing to plot.

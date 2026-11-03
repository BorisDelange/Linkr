## Introduction

Shows one patient's measurements the way a patient record's flowsheet does: the
chosen concepts in rows, the time in columns, and in each cell what the period
holds — the mean heart rate of each six hours, the last lactate of each day —
with, beside it, how many events that figure summarises.

This is a per-patient widget. It reads the warehouse's event tables for the one
patient whose chart is open, matching both the standard and the source concept
id, and searches each table only for the concepts the database's concept count
found in it. When a visit is selected in the sidebar, only that visit's events
count.

## Settings

**Concepts** are the rows, in the order they were picked.

**Columns** cuts the visible window into that many periods of equal length.
Zooming keeps the number of columns and changes their length.

**Aggregate** is what a cell shows of its period's values: the mean, median,
minimum, maximum or sum of the numeric values, how many events there are, or the
value of the period's first or last event — text included, for a categorical
observation.

**Show counts** writes, after each value, the number of events it summarises: a
mean of one reading and a mean of three hundred do not weigh the same.

**Sync time range** shares the window with the other synced widgets of the board
— timelines and data overviews alike — so the table follows a zoom made on a
curve, and the reverse.

## Using it

The arrows move the window by one column; the magnifiers halve or double it
around its middle; the frame button goes back to the patient's whole record for
these concepts. Hovering a cell gives the concept, the aggregate, the number of
events and the period it covers.

The aggregates are computed by the database: a column over a year of monitoring
costs one row, never the year's events, so the table stays light on the largest
records.

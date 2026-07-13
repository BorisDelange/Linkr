"""Reproduce the dashboard's ICU-mortality KPI and break it down by SOFA score.

Run from the project workspace where `icu-stays.csv` lives.
"""
import pandas as pd

df = pd.read_csv("icu-stays.csv")

overall = df["deceased_in_icu"].mean()
print(f"Overall ICU mortality: {overall:.1%}")

by_sofa = (
    df.assign(sofa_band=pd.cut(df["sofa_score"], [0, 4, 8, 12, 20]))
    .groupby("sofa_band", observed=True)["deceased_in_icu"]
    .agg(["mean", "count"])
    .rename(columns={"mean": "mortality", "count": "n"})
)
print("\nMortality by SOFA band:")
print(by_sofa.to_string(float_format=lambda x: f"{x:.1%}"))

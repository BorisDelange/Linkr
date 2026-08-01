import { describe, it, expect } from 'vitest'
import { isImperativeInstall, extractInstallPackages } from './install-detect'

describe('isImperativeInstall', () => {
  it('detects R install calls', () => {
    expect(isImperativeInstall('r', 'install.packages("ggplot2")')).toBe(true)
    expect(isImperativeInstall('r', 'renv::install("readr")')).toBe(true)
    expect(isImperativeInstall('r', 'library(ggplot2)')).toBe(false)
  })

  it('detects Python install calls', () => {
    expect(isImperativeInstall('python', 'pip install pandas')).toBe(true)
    expect(isImperativeInstall('python', '!pip install numpy')).toBe(true)
    expect(isImperativeInstall('python', 'import pandas')).toBe(false)
  })
})

describe('extractInstallPackages — R', () => {
  it('pulls a single package name', () => {
    expect(extractInstallPackages('r', 'install.packages("ggplot2")')).toEqual(['ggplot2'])
  })

  it('pulls a vector of names', () => {
    expect(extractInstallPackages('r', 'install.packages(c("dplyr", "tidyr"))')).toEqual([
      'dplyr',
      'tidyr',
    ])
  })

  it('handles renv::install and single quotes', () => {
    expect(extractInstallPackages('r', "renv::install('readr')")).toEqual(['readr'])
  })

  it('skips GitHub user/repo refs (devtools/remotes)', () => {
    expect(extractInstallPackages('r', 'devtools::install("tidyverse/dplyr")')).toEqual([])
  })

  it('collects across multiple calls and dedupes', () => {
    const code = 'install.packages("dplyr")\ninstall.packages("dplyr")\nrenv::install("readr")'
    expect(extractInstallPackages('r', code)).toEqual(['dplyr', 'readr'])
  })
})

describe('extractInstallPackages — Python', () => {
  it('pulls multiple names from one pip install', () => {
    expect(extractInstallPackages('python', 'pip install pandas numpy')).toEqual([
      'pandas',
      'numpy',
    ])
  })

  it('keeps a version spec', () => {
    expect(extractInstallPackages('python', 'pip install "pandas==2.1.4"')).toEqual([
      'pandas==2.1.4',
    ])
  })

  it('drops flags', () => {
    expect(extractInstallPackages('python', 'pip install -U --quiet polars')).toEqual(['polars'])
  })

  it('handles !pip and uv add', () => {
    expect(extractInstallPackages('python', '!pip install seaborn')).toEqual(['seaborn'])
    expect(extractInstallPackages('python', 'uv add duckdb')).toEqual(['duckdb'])
  })

  it('skips a -r requirements file value', () => {
    expect(extractInstallPackages('python', 'pip install -r requirements.txt')).toEqual([])
  })

  it('returns [] for a URL install (no valid CRAN/PyPI name)', () => {
    expect(extractInstallPackages('r', 'install.packages("https://x.tar.gz")')).toEqual([])
  })
})

import { Database, FileCode, FileText, Globe, Notebook, type LucideIcon } from 'lucide-react'

export type FileCategory = 'scripts' | 'notebooks' | 'web_apps' | 'documents'

export const FILE_CATEGORIES: FileCategory[] = ['scripts', 'notebooks', 'web_apps', 'documents']

export interface FileType {
  id: string
  /** i18n key. */
  label: string
  ext: string
  lang: string
  category: FileCategory
  icon: LucideIcon
  /** Mirrors the IDE sidebar (FileTreeItem): Python yellow, R blue, SQL orange… */
  iconColor: string
  /** Proposed when the name field is empty: a name the framework expects. */
  defaultName?: string
  /** What every new file of the type starts with: a notebook is not valid empty,
   *  and an empty web app is not recognised as one. */
  skeleton?: string
  /** Written when "Start from an example" is on. A web app's example is
   *  recognised by the IDE's "Run app" (see the server's web_apps presets). */
  example?: string
}

const IPYNB_SKELETON = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python', version: '3.11.0' },
  },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Untitled Notebook\n'] },
    { cell_type: 'code', metadata: {}, source: [''], execution_count: null, outputs: [] },
  ],
}, null, 1)

const PYTHON_EXAMPLE = `import pandas as pd

df = pd.DataFrame({
    "patient": ["A", "B", "C", "D"],
    "age": [54, 67, 71, 48],
    "los_days": [3, 8, 5, 2],
})

print(df.describe())
df
`

const R_EXAMPLE = `df <- data.frame(
  patient = c("A", "B", "C", "D"),
  age = c(54, 67, 71, 48),
  los_days = c(3, 8, 5, 2)
)

summary(df)
plot(df$age, df$los_days, xlab = "Age", ylab = "Length of stay (days)")
`

const SQL_EXAMPLE = `-- Patients by year of birth (OMOP)
SELECT year_of_birth, COUNT(*) AS n
FROM person
GROUP BY year_of_birth
ORDER BY year_of_birth
LIMIT 20;
`

const SHINY_EXAMPLE = `library(shiny)

ui <- fluidPage(
  titlePanel("Old Faithful eruptions"),
  sidebarLayout(
    sidebarPanel(
      sliderInput("bins", "Number of bins", min = 5, max = 50, value = 20)
    ),
    mainPanel(plotOutput("hist"))
  )
)

server <- function(input, output, session) {
  output$hist <- renderPlot({
    hist(faithful$waiting, breaks = input$bins, col = "#5b9bd5", border = "white",
         main = NULL, xlab = "Waiting time between eruptions (min)")
  })
}

shinyApp(ui, server)
`

const PLUMBER_EXAMPLE = `#* @apiTitle Example API

#* Echo back a message
#* @param msg The message to echo
#* @get /echo
function(msg = "") {
  list(msg = paste0("The message is: '", msg, "'"))
}

#* Summary of a built-in dataset
#* @get /summary
function() {
  as.list(summary(mtcars$mpg))
}
`

const SHINY_PYTHON_EXAMPLE = `from shiny.express import input, render, ui

ui.input_slider("n", "Number of points", 10, 500, 100)


@render.plot
def scatter():
    import matplotlib.pyplot as plt
    import numpy as np

    rng = np.random.default_rng(1)
    x = rng.normal(size=input.n())
    fig, ax = plt.subplots()
    ax.scatter(x, x + rng.normal(scale=0.5, size=input.n()))
    return fig
`

const STREAMLIT_EXAMPLE = `import numpy as np
import pandas as pd
import streamlit as st

st.title("Simulated vital signs")

hours = st.slider("Hours", 12, 168, 48)
rng = np.random.default_rng(42)
df = pd.DataFrame(
    {
        "Heart rate": 80 + rng.normal(0, 8, hours).cumsum() * 0.3,
        "MAP": 75 + rng.normal(0, 5, hours).cumsum() * 0.2,
    },
    index=pd.date_range("2026-01-01", periods=hours, freq="h"),
)

c1, c2 = st.columns(2)
c1.metric("Mean heart rate", f"{df['Heart rate'].mean():.0f} bpm")
c2.metric("Mean MAP", f"{df['MAP'].mean():.0f} mmHg")
st.line_chart(df)
`

// The skeletons need only their framework (and what it installs itself), so a
// new app runs before any package is added; the examples may need more.
const SHINY_SKELETON = `library(shiny)

ui <- fluidPage(
  titlePanel("Sampling a normal distribution"),
  sidebarLayout(
    sidebarPanel(
      sliderInput("n", "Sample size", min = 10, max = 2000, value = 200),
      sliderInput("sd", "Standard deviation", min = 0.5, max = 3, value = 1, step = 0.5)
    ),
    mainPanel(plotOutput("hist"))
  )
)

server <- function(input, output, session) {
  output$hist <- renderPlot({
    x <- rnorm(input$n, sd = input$sd)
    hist(x, breaks = 30, col = "#5b9bd5", border = "white", main = NULL, xlim = c(-10, 10))
  })
}

shinyApp(ui, server)
`

const PLUMBER_SKELETON = `#* @apiTitle Plot API

#* A histogram of a normal sample, as an image: open /plot?n=500
#* @param n Sample size
#* @serializer png
#* @get /plot
function(n = 200) {
  hist(rnorm(as.integer(n)), breaks = 30, col = "#5b9bd5", border = "white", main = NULL)
}

#* @get /
function() {
  list(try = "/plot?n=500")
}
`

const SHINY_PYTHON_SKELETON = `import math

from shiny.express import input, render, ui

ui.h2("Damped oscillation")
ui.input_slider("frequency", "Frequency", 0.5, 5, 1, step=0.5)
ui.input_slider("damping", "Damping", 0, 1, 0.2, step=0.1)


@render.ui
def curve():
    # Drawn as SVG: no plotting package needed.
    width, height = 600, 240
    points = []
    for i in range(400):
        x = i / 20
        y = math.exp(-input.damping() * x) * math.sin(2 * math.pi * input.frequency() * x)
        points.append(f"{i * width / 400:.1f},{height / 2 - y * height / 2.2:.1f}")
    return ui.HTML(
        f'<svg width="{width}" height="{height}" style="border:1px solid #ddd">'
        f'<polyline fill="none" stroke="#5b9bd5" stroke-width="2" points="{" ".join(points)}"/></svg>'
    )
`

const STREAMLIT_SKELETON = `import math

import streamlit as st

st.title("Damped oscillation")

frequency = st.slider("Frequency", 0.5, 5.0, 1.0, 0.5)
damping = st.slider("Damping", 0.0, 1.0, 0.2, 0.1)

t = [i / 20 for i in range(400)]
y = [math.exp(-damping * x) * math.sin(2 * math.pi * frequency * x) for x in t]
st.line_chart({"Time (s)": t, "Amplitude": y}, x="Time (s)", y="Amplitude")
`

const GRADIO_SKELETON = `import math

import gradio as gr
import pandas as pd


def curve(frequency: float, damping: float) -> pd.DataFrame:
    t = [i / 20 for i in range(400)]
    y = [math.exp(-damping * x) * math.sin(2 * math.pi * frequency * x) for x in t]
    return pd.DataFrame({"time": t, "amplitude": y})


with gr.Blocks(title="Damped oscillation") as demo:
    gr.Markdown("## Damped oscillation")
    frequency = gr.Slider(0.5, 5, value=1, step=0.5, label="Frequency")
    damping = gr.Slider(0, 1, value=0.2, step=0.1, label="Damping")
    plot = gr.LinePlot(x="time", y="amplitude")
    for control in (frequency, damping):
        control.change(curve, [frequency, damping], plot)
    demo.load(curve, [frequency, damping], plot)

demo.launch()
`

const FASTAPI_SKELETON = `import math

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, Response

app = FastAPI(title="Plot API")


@app.get("/", response_class=HTMLResponse)
def root():
    # Relative links: the app is served under Linkr's path, not at the root.
    return '<h2>Damped oscillation</h2><p><a href="plot.svg?frequency=2&damping=0.3">plot.svg?frequency=2&damping=0.3</a></p>'


@app.get("/plot.svg")
def plot(frequency: float = 1, damping: float = 0.2):
    width, height = 600, 240
    points = " ".join(
        f"{i * width / 400:.1f},{height / 2 - math.exp(-damping * i / 20) * math.sin(2 * math.pi * frequency * i / 20) * height / 2.2:.1f}"
        for i in range(400)
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
        f'<polyline fill="none" stroke="#5b9bd5" stroke-width="2" points="{points}"/></svg>'
    )
    return Response(svg, media_type="image/svg+xml")
`

const DASH_SKELETON = `import math

import plotly.graph_objects as go
from dash import Dash, Input, Output, dcc, html

app = Dash(__name__)
app.layout = html.Div([
    html.H2("Damped oscillation"),
    html.Label("Frequency"),
    dcc.Slider(0.5, 5, 0.5, value=1, id="frequency"),
    html.Label("Damping"),
    dcc.Slider(0, 1, 0.1, value=0.2, id="damping"),
    dcc.Graph(id="graph"),
])


@app.callback(Output("graph", "figure"), Input("frequency", "value"), Input("damping", "value"))
def update(frequency, damping):
    t = [i / 20 for i in range(400)]
    y = [math.exp(-damping * x) * math.sin(2 * math.pi * frequency * x) for x in t]
    fig = go.Figure(go.Scatter(x=t, y=y, mode="lines"))
    fig.update_layout(xaxis_title="Time (s)", yaxis_title="Amplitude", margin=dict(t=20))
    return fig


if __name__ == "__main__":
    app.run()
`

const DASH_EXAMPLE = `import plotly.express as px
from dash import Dash, Input, Output, dcc, html

df = px.data.gapminder()

app = Dash(__name__)
app.layout = html.Div([
    html.H2("Life expectancy"),
    dcc.Dropdown(sorted(df.continent.unique()), "Europe", id="continent"),
    dcc.Graph(id="graph"),
])


@app.callback(Output("graph", "figure"), Input("continent", "value"))
def update(continent):
    data = df[df.continent == continent]
    return px.line(data, x="year", y="lifeExp", color="country")


if __name__ == "__main__":
    app.run()
`

const GRADIO_EXAMPLE = `import gradio as gr


def bmi(weight_kg: float, height_cm: float) -> str:
    value = weight_kg / (height_cm / 100) ** 2
    return f"BMI: {value:.1f}"


demo = gr.Interface(
    fn=bmi,
    inputs=[gr.Number(label="Weight (kg)", value=70), gr.Number(label="Height (cm)", value=175)],
    outputs="text",
    title="BMI calculator",
)

demo.launch()
`

const FASTAPI_EXAMPLE = `from fastapi import FastAPI

app = FastAPI(title="Example API")


@app.get("/")
def root():
    return {"message": "Hello from Linkr"}


@app.get("/square/{n}")
def square(n: int):
    return {"n": n, "square": n * n}
`

export const FILE_TYPES: FileType[] = [
  { id: 'py', label: 'files.type_python', ext: '.py', lang: 'python', category: 'scripts', icon: FileCode, iconColor: 'text-yellow-500', example: PYTHON_EXAMPLE },
  { id: 'r', label: 'files.type_r', ext: '.R', lang: 'r', category: 'scripts', icon: FileCode, iconColor: 'text-blue-500', example: R_EXAMPLE },
  { id: 'sql', label: 'files.type_sql', ext: '.sql', lang: 'sql', category: 'scripts', icon: Database, iconColor: 'text-orange-400', example: SQL_EXAMPLE },
  {
    id: 'rmd', label: 'files.type_rmd', ext: '.Rmd', lang: 'markdown', category: 'notebooks', icon: Notebook, iconColor: 'text-blue-500',
    skeleton: '---\ntitle: "Untitled"\noutput: html_document\n---\n\n# Introduction\n\nWrite your analysis here.\n\n```{r setup}\nlibrary(dplyr)\n```\n',
  },
  {
    id: 'qmd', label: 'files.type_qmd', ext: '.qmd', lang: 'markdown', category: 'notebooks', icon: Notebook, iconColor: 'text-violet-500',
    skeleton: '---\ntitle: "Untitled"\nformat: html\n---\n\n# Introduction\n\nWrite your analysis here.\n\n```{python}\nimport pandas as pd\n```\n',
  },
  { id: 'ipynb', label: 'files.type_ipynb', ext: '.ipynb', lang: 'json', category: 'notebooks', icon: Notebook, iconColor: 'text-amber-500', skeleton: IPYNB_SKELETON },
  { id: 'shiny', label: 'files.type_shiny', ext: '.R', lang: 'r', category: 'web_apps', icon: Globe, iconColor: 'text-blue-500', defaultName: 'app', skeleton: SHINY_SKELETON, example: SHINY_EXAMPLE },
  { id: 'plumber', label: 'files.type_plumber', ext: '.R', lang: 'r', category: 'web_apps', icon: Globe, iconColor: 'text-blue-500', defaultName: 'plumber', skeleton: PLUMBER_SKELETON, example: PLUMBER_EXAMPLE },
  { id: 'shiny-python', label: 'files.type_shiny_python', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: SHINY_PYTHON_SKELETON, example: SHINY_PYTHON_EXAMPLE },
  { id: 'streamlit', label: 'files.type_streamlit', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: STREAMLIT_SKELETON, example: STREAMLIT_EXAMPLE },
  { id: 'dash', label: 'files.type_dash', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: DASH_SKELETON, example: DASH_EXAMPLE },
  { id: 'gradio', label: 'files.type_gradio', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: GRADIO_SKELETON, example: GRADIO_EXAMPLE },
  { id: 'fastapi', label: 'files.type_fastapi', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'api', skeleton: FASTAPI_SKELETON, example: FASTAPI_EXAMPLE },
  { id: 'md', label: 'files.type_markdown', ext: '.md', lang: 'markdown', category: 'documents', icon: FileText, iconColor: 'text-muted-foreground' },
  { id: 'csv', label: 'files.type_csv', ext: '.csv', lang: 'plaintext', category: 'documents', icon: FileText, iconColor: 'text-emerald-500' },
  { id: 'txt', label: 'files.type_text', ext: '.txt', lang: 'plaintext', category: 'documents', icon: FileText, iconColor: 'text-muted-foreground' },
]

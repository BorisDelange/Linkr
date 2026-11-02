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
  { id: 'shiny', label: 'files.type_shiny', ext: '.R', lang: 'r', category: 'web_apps', icon: Globe, iconColor: 'text-blue-500', defaultName: 'app', skeleton: 'library(shiny)\n\nui <- fluidPage(\n  h2("Hello")\n)\n\nserver <- function(input, output, session) {\n}\n\nshinyApp(ui, server)\n', example: SHINY_EXAMPLE },
  { id: 'plumber', label: 'files.type_plumber', ext: '.R', lang: 'r', category: 'web_apps', icon: Globe, iconColor: 'text-blue-500', defaultName: 'plumber', skeleton: '#* @get /\nfunction() {\n  list(status = "ok")\n}\n', example: PLUMBER_EXAMPLE },
  { id: 'shiny-python', label: 'files.type_shiny_python', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: 'from shiny.express import ui\n\nui.h2("Hello")\n', example: SHINY_PYTHON_EXAMPLE },
  { id: 'streamlit', label: 'files.type_streamlit', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: 'import streamlit as st\n\nst.title("Hello")\n', example: STREAMLIT_EXAMPLE },
  { id: 'dash', label: 'files.type_dash', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: 'from dash import Dash, html\n\napp = Dash(__name__)\napp.layout = html.Div("Hello")\n\nif __name__ == "__main__":\n    app.run()\n', example: DASH_EXAMPLE },
  { id: 'gradio', label: 'files.type_gradio', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'app', skeleton: 'import gradio as gr\n\ndemo = gr.Interface(fn=lambda name: f"Hello {name}", inputs="text", outputs="text")\n\ndemo.launch()\n', example: GRADIO_EXAMPLE },
  { id: 'fastapi', label: 'files.type_fastapi', ext: '.py', lang: 'python', category: 'web_apps', icon: Globe, iconColor: 'text-yellow-500', defaultName: 'api', skeleton: 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef root():\n    return {"message": "Hello"}\n', example: FASTAPI_EXAMPLE },
  { id: 'md', label: 'files.type_markdown', ext: '.md', lang: 'markdown', category: 'documents', icon: FileText, iconColor: 'text-muted-foreground' },
  { id: 'csv', label: 'files.type_csv', ext: '.csv', lang: 'plaintext', category: 'documents', icon: FileText, iconColor: 'text-emerald-500' },
  { id: 'txt', label: 'files.type_text', ext: '.txt', lang: 'plaintext', category: 'documents', icon: FileText, iconColor: 'text-muted-foreground' },
]

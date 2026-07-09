/**
 * Official brand logos for the code languages users write widgets/analyses in.
 * lucide-react dropped brand icons, so these are inline SVGs of the real marks
 * (Python's two-snake logo, the R logo). Reused wherever a language is picked.
 */

interface LanguageIconProps {
  size?: number
  className?: string
}

/** Python logo — two intertwined snakes (blue #3776AB / yellow #FFD43B). */
export function PythonLogo({ size = 20, className }: LanguageIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 255"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="linkr-python-blue" x1="12.959%" y1="12.039%" x2="79.639%" y2="78.201%">
          <stop offset="0%" stopColor="#387EB8" />
          <stop offset="100%" stopColor="#366994" />
        </linearGradient>
        <linearGradient id="linkr-python-yellow" x1="19.128%" y1="20.579%" x2="90.742%" y2="88.429%">
          <stop offset="0%" stopColor="#FFE052" />
          <stop offset="100%" stopColor="#FFC331" />
        </linearGradient>
      </defs>
      <path
        fill="url(#linkr-python-blue)"
        d="M126.916.072c-64.832 0-60.784 28.115-60.784 28.115l.072 29.128h61.868v8.745H41.631S.145 61.355.145 126.77c0 65.417 36.21 63.097 36.21 63.097h21.61v-30.356s-1.165-36.21 35.632-36.21h61.362s34.475.557 34.475-33.319V33.97S194.67.072 126.916.072zM92.802 19.66a11.12 11.12 0 0 1 11.13 11.13 11.12 11.12 0 0 1-11.13 11.13 11.12 11.12 0 0 1-11.13-11.13 11.12 11.12 0 0 1 11.13-11.13z"
      />
      <path
        fill="url(#linkr-python-yellow)"
        d="M128.757 254.126c64.832 0 60.784-28.115 60.784-28.115l-.072-29.127H127.6v-8.745h86.441s41.486 4.705 41.486-60.712c0-65.416-36.21-63.096-36.21-63.096h-21.61v30.355s1.165 36.21-35.632 36.21h-61.362s-34.475-.557-34.475 33.32v56.013s-5.235 33.897 62.518 33.897zm34.114-19.586a11.12 11.12 0 0 1-11.13-11.13 11.12 11.12 0 0 1 11.13-11.131 11.12 11.12 0 0 1 11.13 11.13 11.12 11.12 0 0 1-11.13 11.13z"
      />
    </svg>
  )
}

/**
 * R logo — the official mark (r-project.org/logo): a grey gradient ring with a
 * blue "R". Both shapes use the even-odd fill rule (the ring and the R's counter
 * are cut out), exactly as in the source SVG.
 */
export function RLogo({ size = 20, className }: LanguageIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 724 561"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="linkr-r-ring" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#CBCED0" />
          <stop offset="1" stopColor="#84838B" />
        </linearGradient>
        <linearGradient id="linkr-r-letter" x1="0" y1="0.5" x2="1" y2="0.5">
          <stop offset="0" stopColor="#276DC3" />
          <stop offset="1" stopColor="#165CAA" />
        </linearGradient>
      </defs>
      <path
        fill="url(#linkr-r-ring)"
        fillRule="evenodd"
        d="M361.453 485.937C162.329 485.937 0.906 377.828 0.906 244.469 0.906 111.109 162.329 3 361.453 3 560.578 3 722 111.109 722 244.469c0 133.359-161.422 241.468-360.547 241.468zM416.641 97.406c-121.238 0-219.508 63.375-219.508 141.531 0 78.157 98.27 141.532 219.508 141.532 121.239 0 217.559-42.063 217.559-141.532 0-99.468-96.32-141.531-217.559-141.531z"
      />
      <path
        fill="url(#linkr-r-letter)"
        fillRule="evenodd"
        d="M550.688 377.938s14.542 4.376 23.109 8.594c2.941 1.449 8.078 4.484 11.797 7.906 3.343 3.079 5.156 6.457 5.156 6.457l83.906 141.605-135.129 0.062-63.375-118.906s-12.977-22.394-20.992-28.812c-6.688-5.356-9.539-7.266-16.297-7.266h-32.109l0.011 154.918-119.578 0.017V116.048h239.895s109.219 1.972 109.219 105.917c0 103.945-85.617 129.998-85.617 129.998zM486.578 202.5l-72.723-0.06-0.037 63.583 72.76 0.033s33.694-0.05 33.694-32.226c0-32.816-33.694-31.33-33.694-31.33z"
      />
    </svg>
  )
}

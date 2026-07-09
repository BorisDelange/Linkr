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

/** R logo — grey ring with a blue "R". */
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
      <path
        fill="#8CAAC4"
        d="M361.453 485.937C162.329 485.937.906 377.828.906 244.469.906 111.109 162.329 3 361.453 3c199.124 0 360.547 108.109 360.547 241.469 0 133.359-161.423 241.468-360.547 241.468zM416 87C246.283 87 108.75 172.019 108.75 276.875S246.283 466.75 416 466.75c169.717 0 289.5-84.019 289.5-189.875S585.717 87 416 87z"
      />
      <path
        fill="#1E63B9"
        d="M550 358.522c14.786 4.362 45.902 12.437 51 15 6.373 3.203 22.174 9.542 28 19 5.001 8.115 7.516 13.264 11 21l58 100-95 .456L558 462s-22.784-38.522-29-49c-5.822-9.814-11.436-11.226-15-12s-21.667-.522-21.667-.522H478V559l-84 .456V222h179s81.5 1.688 81.5 68.5-54.5 68.022-54.5 68.022zM511 289.522l-33-.044v-45h35c4.373 0 25 1.5 25 22 0 20.291-16.667 22.813-27 23.044z"
      />
    </svg>
  )
}

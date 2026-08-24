/**
 * The MyoPlan brand mark — four modular tiles. Used as the built-in site logo wherever a
 * deployment has not uploaded a custom one (i.e. as the `SiteLogo` fallback).
 *
 * The teal and mint tiles are fixed brand colors and read on both light and dark surfaces. The
 * two "ink" shapes would disappear on a dark canvas, so they take their fill from
 * `--myoplan-mark-ink`, which styles.css flips to near-white in dark mode.
 */
export default function MyoPlanMark({
  size = 24,
  className,
  title = 'MyoPlan OS',
}: {
  size?: number
  className?: string
  title?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 96 96"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      className={className}
    >
      <path fill="#2AAFC0" d="M8 0h26a10 10 0 0 1 10 10v34H10A10 10 0 0 1 0 34V8a8 8 0 0 1 8-8Z" />
      <circle cx="74" cy="22" r="22" fill="var(--myoplan-mark-ink, #0F172A)" />
      <path
        fill="var(--myoplan-mark-ink, #0F172A)"
        d="M0 62a10 10 0 0 1 10-10h34v34a10 10 0 0 1-10 10H8a8 8 0 0 1-8-8V62Z"
      />
      <path fill="#65E6D2" d="M52 52h34a10 10 0 0 1 10 10v26a8 8 0 0 1-8 8H62a10 10 0 0 1-10-10V52Z" />
    </svg>
  )
}

function Svg({ children, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconGrip(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props} strokeWidth="0" fill="currentColor">
      {[5, 8, 11].flatMap((cy) =>
        [5, 11].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.1" />),
      )}
    </Svg>
  );
}

export function IconTrash(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5" />
      <path d="M4.25 4.5l.55 8.25a1 1 0 0 0 1 .95h4.4a1 1 0 0 0 1-.95l.55-8.25" />
      <path d="M6.5 7.25v4" />
      <path d="M9.5 7.25v4" />
    </Svg>
  );
}

export function IconX(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </Svg>
  );
}

export function IconArrowLeft(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 8H4" />
      <path d="M7.5 4.5L4 8l3.5 3.5" />
    </Svg>
  );
}

export function IconChevronRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 3.5L10 8l-4 4.5" />
    </Svg>
  );
}

export function IconChevronDown(props: React.SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3.5 6l4.5 4 4.5-4" />
    </Svg>
  );
}

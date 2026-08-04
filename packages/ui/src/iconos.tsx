import type { SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "children">;

function base(props: Props): SVGProps<SVGSVGElement> {
  return {
    width: "1em",
    height: "1em",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

export function IconoChevron(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconoCheck(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

export function IconoHerramienta(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M14.5 6.2a4 4 0 0 1 5.3 5.3l-8.3 8.3a2.4 2.4 0 0 1-3.4-3.4l8.3-8.3Z" />
      <path d="M4.2 4.2 8 8" />
      <path d="M8 4.2 4.2 8" />
    </svg>
  );
}

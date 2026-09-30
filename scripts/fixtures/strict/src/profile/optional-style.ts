/** An optional property written as undefined: an error under exactOptionalPropertyTypes only. */
export interface Style {
  fill?: string;
}

export const style: Style = { fill: undefined };

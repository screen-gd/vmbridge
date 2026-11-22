import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Conditional class names, merged so a later Tailwind class wins over an earlier one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

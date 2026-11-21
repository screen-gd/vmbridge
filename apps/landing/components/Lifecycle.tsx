import { copy } from "@/lib/copy";
import { Section } from "./Section";

const markers = [
  "size-2.5 rounded-full bg-primary",
  "size-2.5 rounded-full ring-1 ring-primary",
  "size-2.5 rounded-full ring-1 ring-white/40",
  "size-2.5 animate-pulse rounded-full bg-primary",
];

const lines = [
  "h-px flex-1 bg-white/20",
  "h-0 flex-1 border-t border-dashed border-white/20",
  "h-0 flex-1 border-t border-dashed border-white/20",
  "h-px flex-1 bg-primary/60",
];

/** The four VM states as a left-to-right track: marker, line, name, body. */
export function Lifecycle() {
  return (
    <Section id="lifecycle" title={copy.lifecycle.title} body={copy.lifecycle.body}>
      <ol className="grid gap-8 sm:grid-cols-4 sm:gap-6">
        {copy.lifecycle.states.map((state, i) => (
          <li key={state.name}>
            <div className="flex items-center gap-3">
              <span className={markers[i]} />
              <span className={`hidden sm:block ${lines[i]}`} />
              <span className="text-sm font-medium sm:hidden">{state.name}</span>
            </div>
            <div className="mt-4 hidden text-sm font-medium sm:block">{state.name}</div>
            <p className="mt-2 text-pretty text-sm text-muted-foreground">{state.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

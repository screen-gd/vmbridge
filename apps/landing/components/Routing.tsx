import { copy } from "@/lib/copy";
import { routes } from "@/lib/data";
import { Section } from "./Section";

/** Which calls the bridge answers itself and which it forwards to a VM. */
export function Routing() {
  return (
    <Section id="routing" title={copy.routing.title} body={copy.routing.body}>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[520px] font-mono text-[13px]">
          <thead>
            <tr>
              <th className="px-4 py-3 text-left font-normal text-faint">{copy.routing.columns.call}</th>
              <th className="px-4 py-3 text-left font-normal text-faint">{copy.routing.columns.target}</th>
              <th className="px-4 py-3 text-right font-normal text-faint">{copy.routing.columns.time}</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={route.call} className="border-t">
                <td className="px-4 py-3">{route.call}</td>
                <td className={`px-4 py-3 ${route.kind === "vm" ? "text-primary" : "text-foreground"}`}>{route.target}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{route.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5 grid gap-2 text-sm text-muted-foreground">
        <p className="flex items-center gap-2.5">
          <span className="size-2 rounded-[2px] bg-white" />
          {copy.routing.notes.bridge}
        </p>
        <p className="flex items-center gap-2.5">
          <span className="size-2 rounded-[2px] bg-primary" />
          {copy.routing.notes.vm}
        </p>
      </div>
    </Section>
  );
}

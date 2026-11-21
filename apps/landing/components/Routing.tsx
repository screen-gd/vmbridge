import { copy } from "@/lib/copy";
import { routes } from "@/lib/data";
import { Section } from "./Section";
import { Topology } from "./Topology";
import { Window } from "./Window";

/** The wiring diagram, then which calls the bridge answers itself and which it forwards to a VM. */
export function Routing() {
  return (
    <Section id="routing" title={copy.routing.title} body={copy.routing.body}>
      <Topology />
      <p className="mt-4 font-mono text-xs text-faint">{copy.hero.hint}</p>
      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,8fr)_minmax(0,5fr)] lg:items-center">
        <Window title="vmbridge.log">
          <div className="overflow-x-auto">
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
        </Window>
        <div className="grid gap-2 text-sm text-muted-foreground">
          <p className="flex items-center gap-2.5">
            <span className="size-2 rounded-[2px] bg-white" />
            {copy.routing.notes.bridge}
          </p>
          <p className="flex items-center gap-2.5">
            <span className="size-2 rounded-[2px] bg-primary" />
            {copy.routing.notes.vm}
          </p>
        </div>
      </div>
    </Section>
  );
}

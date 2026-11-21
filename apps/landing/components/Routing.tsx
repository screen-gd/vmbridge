import { copy } from "@/lib/copy";
import { bridgeLatency, routes, vmLatency } from "@/lib/data";
import { cell } from "@/lib/styles";
import { Section } from "./Section";
import { Topology } from "./Topology";
import { Panel } from "./Window";

/** The wiring diagram on top, then which calls the bridge answers itself and which go to a VM. */
export function Routing() {
  return (
    <Section id="routing" title={copy.routing.title} body={copy.routing.body}>
      <div className="border-b">
        <Topology />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Panel label="vmbridge.log">
            <table className="hidden w-full font-mono text-[13px] sm:table">
              <thead>
                <tr>
                  <th className="px-6 py-4 text-left font-normal text-faint sm:px-8">{copy.routing.columns.call}</th>
                  <th className="px-6 py-4 text-left font-normal text-faint sm:px-8">{copy.routing.columns.target}</th>
                  <th className="px-6 py-4 text-right font-normal text-faint sm:px-8">{copy.routing.columns.time}</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr key={route.call} className="border-t">
                    <td className="px-6 py-4 sm:px-8">{route.call}</td>
                    <td className={`px-6 py-4 sm:px-8 ${route.kind === "vm" ? "text-primary" : "text-foreground"}`}>{route.target}</td>
                    <td className="px-6 py-4 text-right tabular-nums text-muted-foreground sm:px-8">{route.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sm:hidden">
              {routes.map((route) => (
                <div key={route.call} className="border-t px-6 py-4 font-mono text-[13px] first:border-t-0">
                  <div className="break-all">{route.call}</div>
                  <div className="mt-1 flex justify-between">
                    <span className={route.kind === "vm" ? "text-primary" : "text-foreground"}>{route.target}</span>
                    <span className="tabular-nums text-muted-foreground">{route.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="flex flex-col border-t lg:col-span-5 lg:border-t-0 lg:border-l">
          <div className={`${cell} flex-1 border-b`}>
            <div className="font-mono text-[2.75rem] leading-none tracking-tight">{bridgeLatency}</div>
            <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">{copy.routing.notes.bridge}</p>
          </div>
          <div className={`${cell} flex-1`}>
            <div className="font-mono text-[2.75rem] leading-none tracking-tight text-primary">{vmLatency}</div>
            <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">{copy.routing.notes.vm}</p>
          </div>
        </div>
      </div>
    </Section>
  );
}

import { copy } from "@/lib/copy";
import { providers } from "@/lib/data";
import { ProviderLogo } from "./brand";
import { Section } from "./Section";

/** The five providers with how each sleeps and wakes, and measured timings. */
export function Providers() {
  return (
    <Section id="providers" title={copy.providers.title} body={copy.providers.body}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr>
              <th className="py-3 pr-4 font-normal text-faint">{copy.providers.columns.provider}</th>
              <th className="py-3 pr-4 font-normal text-faint">{copy.providers.columns.sleep}</th>
              <th className="py-3 pr-4 font-normal text-faint">{copy.providers.columns.ready}</th>
              <th className="py-3 pr-4 font-normal text-faint">{copy.providers.columns.wake}</th>
              <th className="py-3 pr-4 font-normal text-faint">{copy.providers.columns.latency}</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const measured = p.measured;
              const wake = measured
                ? measured.wakeSeconds[0] === measured.wakeSeconds[1]
                  ? `${measured.wakeSeconds[0]} s`
                  : `${measured.wakeSeconds[0]} to ${measured.wakeSeconds[1]} s`
                : null;
              const numeric = "py-4 pr-4 font-mono text-[13px] tabular-nums text-muted-foreground";
              const missing = <span className="text-faint">{copy.providers.unmeasured}</span>;
              return (
                <tr key={p.id} className="border-t">
                  <td className="py-4 pr-4">
                    <span className="flex items-center gap-2.5">
                      <ProviderLogo provider={p} className="size-7" />
                      <span className="font-medium">{p.name}</span>
                    </span>
                  </td>
                  <td className="py-4 pr-4">{p.sleep}</td>
                  <td className={numeric}>{measured ? measured.ready : missing}</td>
                  <td className={numeric}>{wake ?? missing}</td>
                  <td className={numeric}>{measured ? `${measured.browseMs} ms` : missing}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-5 text-sm text-faint">{copy.providers.note}</p>
    </Section>
  );
}

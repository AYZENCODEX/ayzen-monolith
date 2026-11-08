/**
 * components/sylo/charts.tsx
 * Horizontal bar chart wrapper. Colours come from the theme's CSS variables so
 * it follows light/dark and the active accent; recharts gets plain strings.
 */
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface BarDatum { name: string; value: number }

const AXIS = { fill: "var(--color-muted-foreground)", fontSize: 12 } as const;
const ROW_PX = 34;

export function HBarChart({
  data, format, label,
}: { data: readonly BarDatum[]; format: (n: number) => string; label: string }) {
  const height = Math.max(120, data.length * ROW_PX + 32);
  return (
    <div role="img" aria-label={label} style={{ height }} className="w-full font-ui">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={[...data]} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis type="number" tick={AXIS} tickFormatter={format} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="name" tick={AXIS} width={110} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--color-muted)", opacity: 0.5 }}
            formatter={(v: number) => [format(v), ""]}
            separator=""
            contentStyle={{
              background: "var(--color-card)", border: "1px solid var(--color-border)",
              borderRadius: 8, fontSize: 12, color: "var(--color-foreground)",
            }}
          />
          <Bar dataKey="value" fill="var(--color-primary)" radius={[0, 4, 4, 0]} barSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

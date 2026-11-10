import { AuthPanel } from "@/app/login/panel";
import { env } from "@/server/env";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const params = await searchParams;
  return <AuthPanel demoEnabled={env.DEMO_MODE} startInDemo={params.mode === "demo"}/>;
}

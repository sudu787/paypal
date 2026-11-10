import { AuthPanel } from "@/app/login/panel";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const params = await searchParams;
  return <AuthPanel startInDemo={params.mode === "demo"}/>;
}

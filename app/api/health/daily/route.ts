import { dailyMetricsResponse } from "@/lib/daily-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const response = await dailyMetricsResponse(request);
	if (response.status === 401) {
		console.warn("garmin_daily_metrics_unauthenticated", {
			cookiePresent: request.headers.has("cookie"),
		});
	}
	if (response.status !== 404) return response;

	return Response.json(
		{ date: null, provider: "garmin", values: {} },
		{ status: 200, headers: response.headers },
	);
}
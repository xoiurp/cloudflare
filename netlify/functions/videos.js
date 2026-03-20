exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

  if (!ACCOUNT_ID || !API_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: "Missing credentials",
        hasAccountId: !!ACCOUNT_ID,
        hasToken: !!API_TOKEN,
      }),
    };
  }

  const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream`;
  const API_HEADERS = {
    "Authorization": `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    // First request: get videos + total count
    const firstUrl = `${BASE_URL}?include_counts=true&asc=true`;
    console.log("Fetching first batch...");

    const resp = await fetch(firstUrl, { headers: API_HEADERS });
    console.log("CF API status:", resp.status);

    const text = await resp.text();
    console.log("Response length:", text.length);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: "Invalid JSON from Cloudflare API",
          status: resp.status,
          preview: text.substring(0, 500),
        }),
      };
    }

    if (!data.success) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: "Cloudflare API error",
          errors: data.errors,
          messages: data.messages,
        }),
      };
    }

    let allVideos = data.result || [];
    const totalFromApi = data.total || 0;
    const remaining = data.range || 0;
    console.log(`First batch: ${allVideos.length} videos, total: ${totalFromApi}, range: ${remaining}`);

    // Paginate using date cursor if there are more videos
    // Each request returns up to 1000. Use the last video's created date as cursor.
    let safety = 0;
    while (allVideos.length < totalFromApi && safety < 50) {
      safety++;
      const lastVideo = allVideos[allVideos.length - 1];
      if (!lastVideo?.created) break;

      const nextUrl = `${BASE_URL}?include_counts=true&asc=true&start=${encodeURIComponent(lastVideo.created)}`;
      console.log(`Fetching page ${safety + 1}, after: ${lastVideo.created}`);

      const nextResp = await fetch(nextUrl, { headers: API_HEADERS });
      const nextData = await nextResp.json();

      if (!nextData.success || !nextData.result?.length) break;

      // Filter out duplicates (the last video from previous batch may appear again)
      const newVideos = nextData.result.filter(
        (v) => !allVideos.some((existing) => existing.uid === v.uid)
      );

      if (newVideos.length === 0) break;

      allVideos = allVideos.concat(newVideos);
      console.log(`+${newVideos.length} new videos (total: ${allVideos.length})`);
    }

    console.log("Final total:", allVideos.length);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        result: allVideos,
        total: allVideos.length,
        apiTotalCount: totalFromApi,
      }),
    };
  } catch (err) {
    console.error("Function error:", err.message, err.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};

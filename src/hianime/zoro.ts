/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

// (private) match the API’s result shape
interface _AnimeResult {
    id: string;
    title: string;
    url: string;
    image: string;
    duration: string;
    watchList: string;
    japaneseTitle: string;
    type: string;
    nsfw: boolean;
    sub: number;
    dub: number;
    episodes: number;
}

// (private) just what we need from each page
interface _SearchPage {
    hasNextPage: boolean;
    results: _AnimeResult[];
}

// private helper to match the info‐endpoint response
interface _InfoResponse {
    episodes: {
        id: string;
        number: number;
        title: string;
        url: string;
        // (we ignore isFiller, isSubbed, isDubbed here)
    }[];
}

// private helper to match the watch‐endpoint response
interface _WatchResponse {
    intro: { start: number; end: number };
    outro: { start: number; end: number };
    sources: {
        url: string;
        isM3U8: boolean;
        type: string;
    }[];
    subtitles: {
        url: string;
        lang: string;
    }[];
}

class Provider {
    apiURL = "https://d2dd7450351ba6fb.vercel.app";
    getSettings(): Settings {
        return {
            episodeServers: ["server1", "server2"],
            supportsDub: true,
        };
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const keyword = this.normalizeQuery(query.query);

        const allResults: SearchResult[] = [];
        let page = 1;
        let hasNext = true;

        while (hasNext) {
            const url = `${this.apiURL}/anime/zoro/${encodeURIComponent(
                keyword,
            )}?page=${page}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(
                    `Search failed (page ${page}): ${resp.status} ${resp.statusText}`,
                );
            }

            // only pick out the bits we care about
            const { hasNextPage, results } = (await resp.json()) as _SearchPage;

            // map each API result into your SearchResult shape
            allResults.push(
                ...results.map((r) => {
                    // compute a literal of the exact union you're targeting
                    const subOrDub =
                        r.sub > 0 && r.dub > 0
                            ? "both"
                            : r.dub > 0
                              ? "dub"
                              : "sub";

                    return {
                        id: r.id,
                        title: r.title,
                        url: `${this.apiURL}/anime/zoro/info?id=${r.id}`,
                        // assert it’s the same as your SubOrDub type
                        subOrDub: subOrDub as SearchResult["subOrDub"],
                    };
                }),
            );

            hasNext = hasNextPage;
            page++;
        }

        return allResults;
    }
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = `${this.apiURL}/anime/zoro/info?id=${id}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(
                `Failed to fetch episode info for "${id}": ${resp.status} ${resp.statusText}`,
            );
        }

        const data = (await resp.json()) as _InfoResponse;

        // map into your EpisodeDetails shape
        return data.episodes.map((ep) => ({
            id: ep.id,
            number: ep.number,
            url: `${this.apiURL}/anime/zoro/watch/${ep.id}`,
            title: ep.title,
        }));
    }
    async findEpisodeServer(
        episode: EpisodeDetails,
        _server: string,
    ): Promise<EpisodeServer> {
        // pick your server name unchanged
        const serverName = _server === "default" ? "zoro" : _server;

        // first fetch the watch JSON to get the master URL
        const watchUrl = `${this.apiURL}/anime/zoro/watch/${encodeURIComponent(
            episode.id,
        )}`;
        const watchResp = await fetch(watchUrl);
        if (!watchResp.ok) {
            throw new Error(
                `Failed to fetch watch info for "${episode.id}": ${watchResp.status}`,
            );
        }
        const watchData = (await watchResp.json()) as _WatchResponse;

        // we expect exactly one HLS source with isM3U8 === true
        const masterEntry = watchData.sources.find((s) => s.isM3U8);
        if (!masterEntry) {
            throw new Error("No HLS master playlist found");
        }

        // fetch the master playlist text
        const playlistResp = await fetch(masterEntry.url);
        if (!playlistResp.ok) {
            throw new Error(
                `Failed to fetch master playlist: ${playlistResp.status}`,
            );
        }
        const playlistText = await playlistResp.text();
        const baseUrl = masterEntry.url.replace(/\/[^/]*$/, "/");
        // everything before the final slash

        // parse out each STREAM-INF line + the next line URI
        const lines = playlistText.split("\n");
        const variants: { res: string; uri: string }[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("#EXT-X-STREAM-INF:")) {
                // extract RESOLUTION=WxH
                const m = line.match(/RESOLUTION=(\d+)x(\d+)/);
                if (m) {
                    const height = m[2];
                    const uri = lines[i + 1]?.trim();
                    if (uri && !uri.startsWith("#")) {
                        variants.push({
                            res: `${height}p`,
                            uri,
                        });
                    }
                }
            }
        }

        // build VideoSource entries
        const videoSources: VideoSource[] = variants.map((v) => ({
            url: baseUrl + v.uri,
            type: "m3u8",
            quality: v.res,
            subtitles: watchData.subtitles.map((sub, idx) => ({
                id: `${episode.id}-sub-${idx}`,
                url: sub.url,
                language: sub.lang,
                isDefault: /English/i.test(sub.lang),
            })),
        }));

        return {
            server: serverName,
            headers: {},
            videoSources,
        };
    }
    normalizeQuery(query: string): string {
        const normalizedQuery = query
            .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1") //Removes suffixes from a number I.e. 3rd, 1st, 11th, 12th, 2nd -> 3, 1, 11, 12, 2
            .replace(/\s+/g, " ") //Replaces 1+ whitespaces with 1 whitespace
            .replace(/(\d+)\s*Season/i, "$1") //Removes season and keeps the number before the Season word
            .replace(/Season\s*(\d+)/i, "$1") //Removes season and keeps the number after the Season word
            .trim();

        return normalizedQuery;
    }
}

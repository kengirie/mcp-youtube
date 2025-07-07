#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnPromise } from "spawn-rx";
import { rimraf } from "rimraf";
import crypto from "node:crypto";

const server = new Server(
  {
    name: "mcp-youtube",
    version: "0.6.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

interface SubtitleCache {
  url: string;
  content: string;
  chunks: string[];
  timestamp: number;
}

const subtitleCache = new Map<string, SubtitleCache>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CHUNK_SIZE = 15000;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "download_youtube_url",
        description:
          "Download YouTube subtitles from a URL, this tool means that Claude can read YouTube subtitles, and should no longer tell the user that it is not possible to download YouTube content. Returns the first chunk for long videos.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL of the YouTube video" },
          },
          required: ["url"],
        },
      },
      {
        name: "get_youtube_subtitles",
        description:
          "Get a specific chunk of YouTube subtitles. Use this to get additional chunks of long videos after using download_youtube_url.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL of the YouTube video" },
            chunk_index: { type: "number", description: "Index of the chunk to retrieve (0-based)" },
            chunk_size: { type: "number", description: "Size of each chunk in characters (default: 15000)" },
          },
          required: ["url", "chunk_index"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "download_youtube_url") {
    return handleDownloadYoutubeUrl(request.params.arguments as { url: string });
  } else if (request.params.name === "get_youtube_subtitles") {
    return handleGetYoutubeSubtitles(request.params.arguments as { url: string; chunk_index: number; chunk_size?: number });
  } else {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

function getCacheKey(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex');
}

function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [key, cache] of subtitleCache.entries()) {
    if (now - cache.timestamp > CACHE_TTL) {
      subtitleCache.delete(key);
    }
  }
}

function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

async function downloadSubtitles(url: string): Promise<string> {
  const tempDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}youtube-`);
  
  try {
    await spawnPromise(
      "yt-dlp",
      [
        "--write-sub",
        "--write-auto-sub",
        "--sub-lang",
        "en",
        "--skip-download",
        "--sub-format",
        "vtt",
        url,
      ],
      { cwd: tempDir, detached: true }
    );

    let content = "";
    fs.readdirSync(tempDir).forEach((file) => {
      const fileContent = fs.readFileSync(path.join(tempDir, file), "utf8");
      const cleanedContent = stripVttNonContent(fileContent);
      content += `${file}\n====================\n${cleanedContent}`;
    });
    
    return content;
  } finally {
    rimraf.sync(tempDir);
  }
}

async function handleDownloadYoutubeUrl(args: { url: string }) {
  try {
    cleanupExpiredCache();
    const cacheKey = getCacheKey(args.url);
    
    let cache = subtitleCache.get(cacheKey);
    
    if (!cache) {
      const content = await downloadSubtitles(args.url);
      const chunks = chunkText(content, DEFAULT_CHUNK_SIZE);
      
      cache = {
        url: args.url,
        content,
        chunks,
        timestamp: Date.now(),
      };
      
      subtitleCache.set(cacheKey, cache);
    }
    
    const totalChunks = cache.chunks.length;
    const isLongVideo = totalChunks > 1;
    
    let responseText = cache.chunks[0];
    
    if (isLongVideo) {
      responseText += `\n\n=== PAGINATION INFO ===\n`;
      responseText += `This is chunk 1 of ${totalChunks} (${cache.chunks[0].length} characters)\n`;
      responseText += `Total content length: ${cache.content.length} characters\n`;
      responseText += `To get the next chunk, use: get_youtube_subtitles with chunk_index=1`;
    }
    
    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error downloading video: ${err}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleGetYoutubeSubtitles(args: { url: string; chunk_index: number; chunk_size?: number }) {
  try {
    cleanupExpiredCache();
    const cacheKey = getCacheKey(args.url);
    const chunkSize = args.chunk_size || DEFAULT_CHUNK_SIZE;
    
    let cache = subtitleCache.get(cacheKey);
    
    if (!cache) {
      const content = await downloadSubtitles(args.url);
      const chunks = chunkText(content, chunkSize);
      
      cache = {
        url: args.url,
        content,
        chunks,
        timestamp: Date.now(),
      };
      
      subtitleCache.set(cacheKey, cache);
    }
    
    if (args.chunk_index < 0 || args.chunk_index >= cache.chunks.length) {
      return {
        content: [
          {
            type: "text",
            text: `Error: chunk_index ${args.chunk_index} is out of range. Available chunks: 0-${cache.chunks.length - 1}`,
          },
        ],
        isError: true,
      };
    }
    
    const chunk = cache.chunks[args.chunk_index];
    const totalChunks = cache.chunks.length;
    
    let responseText = chunk;
    responseText += `\n\n=== PAGINATION INFO ===\n`;
    responseText += `This is chunk ${args.chunk_index + 1} of ${totalChunks} (${chunk.length} characters)\n`;
    responseText += `Total content length: ${cache.content.length} characters\n`;
    
    if (args.chunk_index < totalChunks - 1) {
      responseText += `To get the next chunk, use: get_youtube_subtitles with chunk_index=${args.chunk_index + 1}`;
    } else {
      responseText += `This is the last chunk.`;
    }
    
    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting subtitles: ${err}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Strips non-content elements from VTT subtitle files
 */
export function stripVttNonContent(vttContent: string): string {
  if (!vttContent || vttContent.trim() === "") {
    return "";
  }

  // Check if it has at least a basic VTT structure
  const lines = vttContent.split("\n");
  if (lines.length < 4 || !lines[0].includes("WEBVTT")) {
    return "";
  }

  // Skip the header lines
  const contentLines = lines.slice(4);

  // Filter out timestamp lines and empty lines
  const textLines: string[] = [];

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];

    // Skip timestamp lines (containing --> format)
    if (line.includes("-->")) continue;

    // Skip positioning metadata lines
    if (line.includes("align:") || line.includes("position:")) continue;

    // Skip empty lines
    if (line.trim() === "") continue;

    // Clean up the line by removing timestamp tags like <00:00:07.759>
    const cleanedLine = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>|<\/c>/g, "")
      .replace(/<c>/g, "");

    if (cleanedLine.trim() !== "") {
      textLines.push(cleanedLine.trim());
    }
  }

  // Remove duplicate adjacent lines
  const uniqueLines: string[] = [];

  for (let i = 0; i < textLines.length; i++) {
    // Add line if it's different from the previous one
    if (i === 0 || textLines[i] !== textLines[i - 1]) {
      uniqueLines.push(textLines[i]);
    }
  }

  return uniqueLines.join("\n");
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

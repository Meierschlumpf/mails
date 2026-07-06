import path from "node:path";
import process from "node:process";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { writeFile } from "node:fs/promises";
import type { gmail_v1 } from "googleapis";

// The scope for reading Gmail labels.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
// The path to the credentials file.
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

/**
 * Lists the labels in the user's account.
 */
async function listMessages() {
  // Authenticate with Google and get an authorized client.
  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  // Create a new Gmail API client.
  const gmail = google.gmail({ version: "v1", auth });

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    maxResults: 5,
  });

  const messages = [];
  for (const { id } of listResponse.data.messages ?? []) {
    if (!id) continue;
    const getResponse = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    if (!getResponse.data.id) continue;

    if (!getResponse.data.payload) {
      console.warn(`Message has no payload id=${id}`);
      continue;
    }

    const headers = getResponse.data.payload?.headers ?? [];

    const subject = getHeaderValue(headers, "Subject");
    const from = getHeaderValue(headers, "From");
    const date = getHeaderValue(headers, "Date");

    messages.push({
      id: getResponse.data.id,
      threadId: getResponse.data.threadId,
      labelIds: getResponse.data.labelIds,
      subject,
      from: parseFrom(from),
      date: new Date(date ?? ""),
      content: parseMessageContent(getResponse.data.payload, getResponse.data.id),
    });
  }

  console.dir(messages, { depth: null });
  await writeFile("messages.json", JSON.stringify(messages, null, 2), "utf-8");
}

interface Header {
  name?: string | null;
  value?: string | null;
}

function getHeaderValue(headers: Header[], key: string): string | null {
  return headers.find(({ name }) => name === key)?.value ?? null;
}

interface From {
  name: string | null;
  email: string;
}
function parseFrom(from: string | null): From | null {
  if (!from) return null;

  if (!from.includes("<")) {
    return {
      name: null,
      email: from,
    };
  }

  try {
    const result = from.match(/(.+)\s<([^>]+)>/);
    return {
      name: result?.at(1)?.replaceAll('"', "") ?? null,
      email: result?.at(2) ?? "",
    };
  } catch (cause) {
    throw new Error(`Failed to parse from value='${from}'`, { cause });
  }
}

function extractParts(part: gmail_v1.Schema$MessagePart, messageId: string): gmail_v1.Schema$MessagePart[] {
  if (!part.mimeType) return [part];

  // multipart/alternative provides different versions of same email
  // multipart/mixed contains different types of content like attachement and multipart/alternative
  if (["multipart/alternative", "multipart/mixed"].includes(part.mimeType.toLowerCase()) && part.parts !== undefined) {
    return part.parts.flatMap((innerPart) => extractParts(innerPart, messageId));
  }
  if (part.mimeType.toLowerCase().startsWith("multipart/")) {
    console.warn(`Found new multipart mimeType id=${messageId} mimeType=${part.mimeType}`);
  }

  return [part];
}

function parseMessageContent(payload: gmail_v1.Schema$MessagePart, messageId: string) {
  const parts = extractParts(payload, messageId);

  if (parts.length === 0) return null;

  const plaintextPart = parts.find(({ headers }) =>
    getHeaderValue(headers ?? [], "Content-Type")?.includes("text/plain"),
  );

  if (plaintextPart) {
    return parseMessagePart(plaintextPart, messageId);
  }

  const dataPart = parts.find(({ body }) => body !== undefined && "data" in body);
  if (!dataPart) return null;

  return parseMessagePart(dataPart, messageId);
}

function parseMessagePart(part: gmail_v1.Schema$MessagePart, messageId: string) {
  const contentType = part.headers?.find((x) => x.name === "Content-Type")?.value;
  const encoding = part.headers?.find((x) => x.name === "Content-Transfer-Encoding")?.value;

  if (!encoding) {
    throw new Error(`Missing Content-Transfer-Encoding header id=${messageId} contentType=${contentType}`);
  }

  // oxlint-disable-next-line typescript/no-non-null-assertion
  const raw = Buffer.from(part.body!.data!, "base64").toString("utf-8");
  const decoded = decodeMessage(raw, encoding, messageId);

  if (!contentType || contentType.includes("text/plain")) {
    return decoded
      .replace(/(?:\r\n)+/g, "\n") // remove duplicate linebreaks
      .trim();
  }

  return decoded
    .replace(/(?:\r\n)+/g, "\n") // remove duplicate linebreaks
    .replace(/<style(?:\s|>)(?:[^<]|\n)+<\/style>/g, "") // remove style tags
    .replace(/\sstyle="[^"]+"/g, "") // remove style attributes
    .replace(/<!--(?:.|\n)*-->/g, "") // remove html comments
    .trim(); // remove whitespace around
}

function decodeMessage(data: string, encoding: string, messageId: string) {
  if (encoding.toLowerCase() === "base64") return data;
  if (encoding.toLowerCase() === "quoted-printable") return data;
  if (encoding.toLowerCase() === "8bit") return data;
  if (encoding.toLowerCase() === "7bit") return decode7BitMessage(data);

  throw new Error(`Unsupported mail encoding: ${encoding.toLowerCase()} id=${messageId}`);
}

function decode7BitMessage(data: string) {
  const binaryString = data
    .replaceAll("=\n", "") // replace quoted-printable soft line breaks
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))); // decode non ascii character encoding in format =5F (equal sign followed by two uppercase hex characters)
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

await listMessages();

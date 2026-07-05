import path from "node:path";
import process from "node:process";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { writeFile } from "node:fs/promises";

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
    const getResponse = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });

    messages.push({
      id: getResponse.data.id,
      threadId: getResponse.data.threadId,
      labelIds: getResponse.data.labelIds,
      subject:
        getResponse.data.payload.headers.find((x) => x.name === "Subject")
          ?.value ?? null,
      from: parseFrom(
        getResponse.data.payload.headers.find((x) => x.name === "From")
          ?.value ?? null,
      ),
      date: new Date(
        getResponse.data.payload.headers.find(({ name }) => name === "Date")
          ?.value,
      ),
      content: parseMessageContent(
        getResponse.data.payload,
        getResponse.data.id,
      ),
    });
  }

  console.dir(messages, { depth: null });
  await writeFile("messages.json", JSON.stringify(messages, null, 2), "utf-8");
}

function parseFrom(from) {
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
      name: result.at(1).replaceAll('"', ""),
      email: result.at(2),
    };
  } catch (cause) {
    throw new Error(`Failed to parse from value='${from}'`, { cause });
  }
}

function extractParts(part, messageId) {
  // multipart/alternative provides different versions of same email
  // multipart/mixed contains different types of content like attachement and multipart/alternative
  if (
    ["multipart/alternative", "multipart/mixed"].includes(
      part.mimeType.toLowerCase(),
    )
  ) {
    return part.parts.flatMap((innerPart) =>
      extractParts(innerPart, messageId),
    );
  }
  if (part.mimeType.toLowerCase().startsWith("multipart/")) {
    console.warn(
      `Found new multipart mimeType id=${messageId} mimeType=${part.mimeType}`,
    );
  }

  return [part];
}

function parseMessageContent(payload, messageId) {
  const parts = extractParts(payload, messageId);

  if (parts.length === 0) return null;

  const plaintextPart = parts.find(({ headers }) =>
    headers
      .find((x) => x.name === "Content-Type")
      ?.value.includes("text/plain"),
  );

  if (plaintextPart) {
    return parseMessagePart(plaintextPart, messageId);
  }

  const dataPart = parts.find(({ body }) => "data" in body);
  if (!dataPart) return null;

  return parseMessagePart(dataPart, messageId);
}

function parseMessagePart(part, messageId) {
  const contentType = part.headers.find(
    (x) => x.name === "Content-Type",
  )?.value;
  const encoding = part.headers.find(
    (x) => x.name === "Content-Transfer-Encoding",
  )?.value;

  const raw = Buffer.from(part.body.data, "base64").toString("utf-8");
  const decoded = decodeMessage(raw, encoding, messageId);

  if (contentType.includes("text/plain")) {
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

function decodeMessage(data, encoding, messageId) {
  if (encoding.toLowerCase() === "base64") return data;
  if (encoding.toLowerCase() === "quoted-printable") return data;
  if (encoding.toLowerCase() === "7bit") return decode7BitMessage(data);

  throw new Error(
    `Unsupported mail encoding: ${encoding.toLowerCase()} id=${messageId}`,
  );
}

function decode7BitMessage(data) {
  const binaryString = data
    .replaceAll("=\n", "") // replace quoted-printable soft line breaks
    .replace(/=([0-9A-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    ); // decode non ascii character encoding in format =5F (equal sign followed by two uppercase hex characters)
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

await listMessages();

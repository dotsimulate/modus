import type { ApiAttachment, Attachment } from "../../sdk/index";

const API_IMAGE_TYPES = new Set<ApiAttachment["mediaType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Narrow composer attachments to the validated REST image contract. */
export function toApiAttachments(attachments: Attachment[]): ApiAttachment[] | undefined {
  if (attachments.length === 0) return undefined;
  return attachments.map((attachment) => {
    if (!API_IMAGE_TYPES.has(attachment.mediaType as ApiAttachment["mediaType"])) {
      throw new Error(`Unsupported image attachment type: ${attachment.mediaType}`);
    }
    return {
      type: "image",
      mediaType: attachment.mediaType as ApiAttachment["mediaType"],
      data: attachment.data,
      name: attachment.name,
    };
  });
}

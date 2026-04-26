import OpenAI from "openai";

type ImageGenerationOutput = {
  type: string;
  result?: string | null;
};

type GenerateImageOptions = {
  openai: OpenAI;
  prompt: string;
  model?: string;
};

type GenerateImageFollowUpOptions = GenerateImageOptions & {
  previousResponseId: string;
};

function getImageBase64(response: { output?: unknown[] }) {
  const imageOutput = response.output
    ?.filter((output): output is ImageGenerationOutput => {
      return typeof output === "object" && output !== null && "type" in output && output.type === "image_generation_call";
    })
    .map((output) => output.result)
    .find((result): result is string => typeof result === "string" && result.length > 0);

  if (!imageOutput) {
    throw new Error("No generated image was returned by the OpenAI response.");
  }

  return imageOutput;
}

export async function generateImageBuffer({
  openai,
  prompt,
  model = "gpt-5.5",
  // model = "gpt-image-1",
}: GenerateImageOptions) {
  const response = await openai.responses.create({
    model,
    input: prompt,
    tools: [{ type: "image_generation" }],
  });

  const imageBase64 = getImageBase64(response);

  return {
    responseId: response.id,
    buffer: Buffer.from(imageBase64, "base64"),
  };
}

export async function generateImageFollowUpBuffer({
  openai,
  previousResponseId,
  prompt,
  model = "gpt-5.5",
  // model = "gpt-image-1",
}: GenerateImageFollowUpOptions) {
  const response = await openai.responses.create({
    model,
    previous_response_id: previousResponseId,
    input: prompt,
    tools: [{ type: "image_generation" }],
  });

  const imageBase64 = getImageBase64(response);

  return {
    responseId: response.id,
    buffer: Buffer.from(imageBase64, "base64"),
  };
}

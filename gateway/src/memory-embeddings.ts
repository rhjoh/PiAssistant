import { Ollama } from "ollama";

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  private client: Ollama;

  constructor(
    private options: {
      host: string;
      model: string;
    }
  ) {
    this.client = new Ollama({ host: options.host });
  }

  async embed(text: string): Promise<number[]> {
    const input = text.trim();
    if (!input) {
      throw new Error("Cannot embed empty text");
    }

    const response = await this.client.embed({
      model: this.options.model,
      input,
    });

    const embedding = response.embeddings[0];
    if (!embedding?.length) {
      throw new Error(`Ollama returned no embedding for ${this.options.model}`);
    }

    return embedding;
  }
}

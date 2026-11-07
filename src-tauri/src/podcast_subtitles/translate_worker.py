"""Private offline EN -> ZH worker. Only bundled CTranslate2/SentencePiece; no HTTP."""
import argparse
import json
import re
from pathlib import Path


def has_chinese(text):
    han = sum("\u3400" <= c <= "\u9fff" for c in text)
    letters = sum(c.isalpha() for c in text)
    return han >= 2 and han / max(1, letters) >= 0.15


def pieces(text, tokenizer):
    # Split at sentence boundaries first, then at token boundaries. Never truncate a paragraph.
    sentences = re.split(r"(?<=[.!?;。！？；])\s+|\n+", text.strip())
    result = []
    for sentence in sentences:
        tokens = tokenizer.encode(sentence.strip(), out_type=str)
        for start in range(0, len(tokens), 160):
            result.append(tokens[start:start + 160])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    import ctranslate2
    import sentencepiece

    # CTranslate2's Windows file opener does not accept canonical \\?\ paths.
    model_path = args.model
    if model_path.startswith("\\\\?\\UNC\\"):
        model_path = "\\\\" + model_path[8:]
    elif model_path.startswith("\\\\?\\"):
        model_path = model_path[4:]
    root = Path(model_path)
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(root / "sentencepiece.model"))
    translator = ctranslate2.Translator(str(root / "model"), device="cpu", compute_type="int8",
                                        inter_threads=1, intra_threads=4)
    rows = json.loads(Path(args.input).read_text(encoding="utf-8"))
    output = []
    for row in rows:
        text = row["text"].strip()
        if has_chinese(text):
            translated = text
        else:
            groups = pieces(text, tokenizer)
            results = translator.translate_batch(groups, beam_size=2, max_decoding_length=512)
            # Source and target vocabularies differ; reconstruct SentencePiece target tokens
            # directly (decoding target ids with the source tokenizer corrupts unknown pieces).
            if any(len(item.hypotheses[0]) >= 512 for item in results):
                raise ValueError("Translation exceeded output limit; original text retained")
            translated = " ".join("".join(item.hypotheses[0]).replace("▁", " ").strip() for item in results)
        if not translated:
            raise ValueError("Empty translation; original text retained")
        output.append({"id": row["id"], "translation": translated})
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()

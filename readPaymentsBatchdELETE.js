require("dotenv").config();

const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

async function readPaymentsBatch(imagePaths) {

    const imageParts = imagePaths.map(imagePath => {
        const image = fs.readFileSync(imagePath, { encoding: "base64" });
        return {
            inlineData: {
                mimeType: "image/png",
                data: image
            }
        };
    });

    const prompt = `
You will be given ${imagePaths.length} images, numbered in the order they appear (image 1 is first, image 2 is second, and so on).

For EACH image independently, determine if it is a payment screenshot, and extract the fields below if so.

Return ONLY a valid JSON array with exactly ${imagePaths.length} elements, no markdown formatting, no code fences. The element at index 0 must correspond to image 1, index 1 to image 2, and so on — array order MUST match image order exactly.

Each element must have this shape:
{
  "isPayment": true,
  "amount": "",
  "utr": "",
  "date": "",
  "time": "",
  "sender": "",
  "receiver": "",
  "bank": ""
}
`;

    const contentParts = [prompt, ...imageParts];

    const result = await model.generateContent(contentParts);
    const responseText = result.response.text();

    try {
        const cleaned = responseText.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleaned);

        if (!Array.isArray(parsed) || parsed.length !== imagePaths.length) {
            throw new Error(`Expected array of ${imagePaths.length}, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
        }

        return parsed;

    } catch (err) {
        console.log("Invalid/mismatched JSON received from Gemini batch call:", err.message);
        console.log(responseText);
        return imagePaths.map(() => ({ isPayment: false }));
    }
}

module.exports = readPaymentsBatch;
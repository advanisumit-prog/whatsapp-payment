require("dotenv").config();

const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function readPayment(imagePath) {

    const image = fs.readFileSync(imagePath, {
        encoding: "base64"
    });

    const prompt = `
This is a payment screenshot.

Return ONLY valid JSON, no markdown formatting, no code fences.

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

    const result = await model.generateContent([
        prompt,
        {
            inlineData: {
                mimeType: "image/png",
                data: image
            }
        }
    ]);

    const responseText = result.response.text();

    try {
        // Gemini sometimes wraps JSON in ```json ... ``` even when told not to — strip that if present
        const cleaned = responseText.replace(/```json|```/g, "").trim();
        return JSON.parse(cleaned);
    } catch (err) {
        console.log("Invalid JSON received from Gemini");
        console.log(responseText);

        return {
            isPayment: false
        };
    }
}

module.exports = readPayment;
const form = document.querySelector("#chat-form");
const promptInput = document.querySelector("#prompt");
const messagesRoot = document.querySelector("#messages");
const sendButton = document.querySelector("#send");

const messages = [
  {
    role: "assistant",
    content: "Hi, I'm your science agent. Ask me anything.",
  },
];

function renderMessages() {
  messagesRoot.innerHTML = "";

  for (const message of messages) {
    const element = document.createElement("article");
    element.className = `message ${message.role}`;
    element.textContent = message.content;
    messagesRoot.appendChild(element);
  }

  messagesRoot.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
}

async function sendMessage(userMessage) {
  messages.push({ role: "user", content: userMessage });
  renderMessages();

  sendButton.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Request failed");
    }

    messages.push({ role: "assistant", content: payload.reply });
    renderMessages();
  } catch (error) {
    messages.push({
      role: "assistant",
      content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
    renderMessages();
  } finally {
    sendButton.disabled = false;
    promptInput.focus();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const value = promptInput.value.trim();
  if (!value) {
    return;
  }

  promptInput.value = "";
  await sendMessage(value);
});

renderMessages();

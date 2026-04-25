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

function formatLabel(label) {
  return label
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

function renderStructuredContent(content) {
  const container = document.createElement("div");

  for (const [key, value] of Object.entries(content)) {
    const section = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = formatLabel(key);
    section.appendChild(title);

    if (Array.isArray(value)) {
      if (value.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "None provided.";
        section.appendChild(empty);
      } else if (value.every((item) => item && typeof item === "object")) {
        const list = document.createElement("div");

        for (const item of value) {
          const block = document.createElement("article");

          for (const [itemKey, itemValue] of Object.entries(item)) {
            const line = document.createElement(itemKey === "url" ? "a" : "p");

            if (itemKey === "url") {
              line.href = String(itemValue);
              line.textContent = String(itemValue);
              line.target = "_blank";
              line.rel = "noreferrer";
            } else {
              line.textContent = `${formatLabel(itemKey)}: ${String(itemValue)}`;
            }

            block.appendChild(line);
          }

          list.appendChild(block);
        }

        section.appendChild(list);
      } else {
        const list = document.createElement(key === "procedure" ? "ol" : "ul");

        for (const item of value) {
          const listItem = document.createElement("li");
          listItem.textContent = String(item);
          list.appendChild(listItem);
        }

        section.appendChild(list);
      }
    } else {
      const body = document.createElement("p");
      body.textContent = String(value);
      section.appendChild(body);
    }

    container.appendChild(section);
  }

  return container;
}

function renderMessages() {
  messagesRoot.innerHTML = "";

  for (const message of messages) {
    const element = document.createElement("article");
    element.className = `message ${message.role}`;

    if (message.content && typeof message.content === "object") {
      element.appendChild(renderStructuredContent(message.content));
    } else {
      element.textContent = message.content;
    }

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

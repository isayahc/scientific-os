const form = document.querySelector("#chat-form");
const promptInput = document.querySelector("#prompt");
const messagesRoot = document.querySelector("#messages");
const sendButton = document.querySelector("#send");
const protocolListRoot = document.querySelector("#protocol-list");

const messages = [
  {
    role: "assistant",
    content: "Hi, I'm your science agent. Ask me anything.",
  },
];

let currentProtocolId = null;
let currentVersionNumber = null;
let currentConversationId = null;
let savedConversations = [];

async function selectProtocol(protocolId) {
  try {
    const response = await fetch(`/api/protocols/${protocolId}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load protocol");
    }

    currentProtocolId = payload.protocolId;
    currentVersionNumber = payload.versionNumber;
    currentConversationId = null;
    messages.length = 0;
    messages.push(
      {
        role: "assistant",
        content: "Loaded saved protocol. You can now ask to modify it.",
      },
      {
        role: "assistant",
        content: payload.reply,
      },
    );
    renderSavedConversations();
    renderMessages();
  } catch (error) {
    messages.push({
      role: "assistant",
      content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
    renderMessages();
  }
}

function renderSavedConversations() {
  protocolListRoot.innerHTML = "";

  if (savedConversations.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No saved conversations yet.";
    protocolListRoot.appendChild(empty);
    return;
  }

  for (const conversation of savedConversations) {
    const item = document.createElement("button");
    item.className = "protocol-item";
    item.type = "button";
    item.dataset.conversationId = conversation.conversationId;
    item.setAttribute("aria-pressed", String(conversation.conversationId === currentConversationId));
    item.addEventListener("click", () => {
      currentConversationId = conversation.conversationId;
      if (conversation.protocolId) {
        void selectProtocol(conversation.protocolId);
      }
    });

    const title = document.createElement("strong");
    title.textContent = conversation.title;

    const meta = document.createElement("small");
    meta.textContent = `Conversation ${conversation.conversationId} • v${conversation.versionNumber ?? "?"}`;

    const abstract = document.createElement("p");
    abstract.textContent = conversation.abstract;

    item.append(title, meta, abstract);
    protocolListRoot.appendChild(item);
  }
}

async function loadSavedConversations() {
  try {
    const response = await fetch("/api/conversations?limit=25");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load conversations");
    }

    savedConversations = payload.conversations;
    renderSavedConversations();
  } catch (error) {
    protocolListRoot.innerHTML = "";
    const failure = document.createElement("p");
    failure.textContent = `Failed to load conversations: ${error instanceof Error ? error.message : "Unknown error"}`;
    protocolListRoot.appendChild(failure);
  }
}

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
    } else if (value && typeof value === "object") {
      const block = document.createElement("article");

      for (const [itemKey, itemValue] of Object.entries(value)) {
        if (Array.isArray(itemValue)) {
          const nestedSection = document.createElement("section");
          const nestedTitle = document.createElement("h3");
          nestedTitle.textContent = formatLabel(itemKey);
          nestedSection.appendChild(nestedTitle);

          if (itemValue.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = "None provided.";
            nestedSection.appendChild(empty);
          } else {
            const nestedList = document.createElement("div");

            for (const nestedItem of itemValue) {
              const nestedBlock = document.createElement("article");

              if (nestedItem && typeof nestedItem === "object") {
                for (const [nestedKey, nestedValue] of Object.entries(nestedItem)) {
                  const line = document.createElement(nestedKey === "sourceUrl" ? "a" : "p");

                  if (nestedKey === "sourceUrl") {
                    line.href = String(nestedValue);
                    line.textContent = String(nestedValue);
                    line.target = "_blank";
                    line.rel = "noreferrer";
                  } else {
                    line.textContent = `${formatLabel(nestedKey)}: ${String(nestedValue)}`;
                  }

                  nestedBlock.appendChild(line);
                }
              } else {
                const line = document.createElement("p");
                line.textContent = String(nestedItem);
                nestedBlock.appendChild(line);
              }

              nestedList.appendChild(nestedBlock);
            }

            nestedSection.appendChild(nestedList);
          }

          block.appendChild(nestedSection);
        } else {
          const line = document.createElement("p");
          line.textContent = `${formatLabel(itemKey)}: ${String(itemValue)}`;
          block.appendChild(line);
        }
      }

      section.appendChild(block);
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

  if (currentProtocolId && currentVersionNumber) {
    const meta = document.createElement("article");
    meta.className = "message assistant";
    meta.textContent = `Saved as protocol ${currentProtocolId} v${currentVersionNumber}`;
    messagesRoot.appendChild(meta);
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
      body: JSON.stringify({
        messages,
        conversationId: currentConversationId,
        protocolId: currentProtocolId,
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Request failed");
    }

    currentConversationId = payload.conversationId ?? currentConversationId;
    currentProtocolId = payload.protocolId ?? currentProtocolId;
    currentVersionNumber = payload.versionNumber ?? currentVersionNumber;
    messages.push({ role: "assistant", content: payload.reply });
    if (payload.protocolId && payload.versionNumber) {
      await loadSavedConversations();
    }
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

loadSavedConversations();
renderMessages();

(() => {
  "use strict";

  const F = window.ProjectFinance;

  const LIST_CODES = {
    projects: "pf_projects_v1",
    categories: "pf_categories_v1",
    operations: "pf_operations_v1"
  };

  const REQUIRED_CATEGORIES = [
    { name: "Доход по проекту", type: "income", system: true },
    { name: "Внешние программисты", type: "expense", system: true },
    { name: "Внутренние программисты", type: "expense", system: true },
    { name: "Расходы на ИИ", type: "expense", system: true },
    { name: "Аренда сервера", type: "expense", system: true },
    { name: "Дивиденды", type: "expense", system: true }
  ];

  const MOCK_USERS = [
    { id: "11", name: "Анна Смирнова" },
    { id: "12", name: "Илья Петров" },
    { id: "13", name: "Мария Коваль" },
    { id: "14", name: "Денис Орлов" }
  ];

  const state = {
    mode: window.self !== window.top && window.BX24 && typeof window.BX24.init === "function" ? "bitrix" : "mock",
    currentUser: null,
    schema: null,
    projects: [],
    categories: [],
    operations: [],
    users: new Map(),
    selectedMembers: []
  };

  const $ = (id) => document.getElementById(id);
  const qs = (selector) => document.querySelector(selector);
  const qsa = (selector) => [...document.querySelectorAll(selector)];

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add("hidden"), 3200);
  }

  function openModal(id) { $(id).classList.remove("hidden"); }
  function closeModal(id) { $(id).classList.add("hidden"); }

  function dateToday() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function normalizeDate(value) {
    if (!value) return "";
    return String(value).slice(0, 10);
  }

  function formatDate(value) {
    if (!value) return "—";
    const d = new Date(`${normalizeDate(value)}T00:00:00`);
    return new Intl.DateTimeFormat("ru-RU").format(d);
  }

  function code(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function isSafePositiveCents(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  class BitrixApi {
    init() {
      return new Promise((resolve) => BX24.init(resolve));
    }

    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        BX24.callMethod(method, params, (result) => {
          if (result.error()) {
            const description = typeof result.error_description === "function"
              ? result.error_description()
              : result.error();
            reject(new Error(description || result.error()));
            return;
          }
          resolve({
            data: result.data(),
            more: typeof result.more === "function" ? result.more() : false
          });
        });
      });
    }

    async all(method, params = {}) {
      const rows = [];
      let start = 0;
      while (true) {
        const response = await this.call(method, { ...params, start });
        const chunk = Array.isArray(response.data) ? response.data : [];
        rows.push(...chunk);
        if (chunk.length < 50) break;
        start += chunk.length;
      }
      return rows;
    }
  }

  const api = new BitrixApi();

  function mapFieldObject(fieldResult) {
    const map = {};
    Object.values(fieldResult || {}).forEach((field) => {
      if (field && field.CODE) map[field.CODE] = field.FIELD_ID;
    });
    return map;
  }

  function propValues(row, fieldId) {
    if (!fieldId) return [];
    const raw = row[fieldId];
    if (raw === null || raw === undefined || raw === "") return [];
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === "object") return Object.values(raw).map(String);
    return [String(raw)];
  }

  function propOne(row, fieldId) {
    return propValues(row, fieldId)[0] ?? "";
  }

  class BitrixStorage {
    async discover() {
      const listEntries = await Promise.all(Object.entries(LIST_CODES).map(async ([key, listCode]) => {
        const response = await api.call("lists.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_CODE: listCode
        });
        const rows = Array.isArray(response.data) ? response.data : [];
        return [key, rows[0] || null];
      }));

      const lists = Object.fromEntries(listEntries);
      if (!lists.projects || !lists.categories || !lists.operations) return null;

      const schema = { lists: {}, fields: {} };
      for (const [key, list] of Object.entries(lists)) {
        schema.lists[key] = String(list.ID);
        const fields = await api.call("lists.field.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: list.ID
        });
        schema.fields[key] = mapFieldObject(fields.data);
      }
      return schema;
    }

    async setup(onProgress) {
      const current = state.currentUser || { ID: "1" };
      const rights = { "*": "W", [`U${current.ID}`]: "X" };

      const findList = async (key) => {
        const response = await api.call("lists.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_CODE: LIST_CODES[key]
        });
        const rows = Array.isArray(response.data) ? response.data : [];
        return rows[0] || null;
      };

      const ensureList = async (key, name, description) => {
        const existing = await findList(key);
        if (existing) {
          onProgress(`Список «${name}» уже существует.`);
          return String(existing.ID);
        }

        onProgress(`Создаю список «${name}»…`);
        const result = await api.call("lists.add", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_CODE: LIST_CODES[key],
          FIELDS: {
            NAME: name,
            DESCRIPTION: description,
            SORT: 500,
            BIZPROC: "N"
          },
          MESSAGES: {
            ELEMENTS_NAME: name,
            ELEMENT_NAME: "Запись",
            ELEMENT_ADD: "Добавить",
            ELEMENT_EDIT: "Изменить",
            ELEMENT_DELETE: "Удалить"
          },
          RIGHTS: rights
        });
        return String(result.data);
      };

      const ensureField = async (listId, spec) => {
        const currentFields = await api.call("lists.field.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: listId
        });
        const exists = Object.values(currentFields.data || {}).some(field => field?.CODE === spec.code);
        if (exists) return;

        onProgress(`Создаю поле «${spec.name}»…`);
        await api.call("lists.field.add", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: listId,
          FIELDS: {
            NAME: spec.name,
            IS_REQUIRED: spec.required ? "Y" : "N",
            MULTIPLE: spec.multiple ? "Y" : "N",
            TYPE: spec.type,
            SORT: spec.sort || 100,
            CODE: spec.code,
            SETTINGS: {
              SHOW_ADD_FORM: "Y",
              SHOW_EDIT_FORM: "Y",
              ADD_READ_ONLY_FIELD: "N",
              EDIT_READ_ONLY_FIELD: "N",
              SHOW_FIELD_PREVIEW: "N"
            }
          }
        });
      };

      const projectId = await ensureList("projects", "PF · Проекты", "Проекты финансового учёта");
      await ensureField(projectId, { name: "Сотрудники", code: "MEMBERS", type: "S:employee", multiple: true });

      const categoryId = await ensureList("categories", "PF · Статьи", "Статьи доходов и расходов");
      await ensureField(categoryId, { name: "Тип", code: "TYPE", type: "S", required: true });
      await ensureField(categoryId, { name: "Системная", code: "SYSTEM", type: "S", required: true, sort: 110 });

      const operationId = await ensureList("operations", "PF · Операции", "Финансовые операции по проектам");
      await ensureField(operationId, { name: "ID проекта", code: "PROJECT_ID", type: "N", required: true });
      await ensureField(operationId, { name: "Тип", code: "TYPE", type: "S", required: true, sort: 110 });
      await ensureField(operationId, { name: "ID статьи", code: "CATEGORY_ID", type: "N", required: true, sort: 120 });
      await ensureField(operationId, { name: "Сумма в копейках", code: "AMOUNT_CENTS", type: "N", required: true, sort: 130 });
      await ensureField(operationId, { name: "Дата", code: "OP_DATE", type: "S:Date", required: true, sort: 140 });
      await ensureField(operationId, { name: "Комментарий", code: "COMMENT", type: "S", sort: 150 });

      const schema = await this.discover();
      if (!schema) throw new Error("Не удалось прочитать созданную структуру");

      const existingCategories = await api.all("lists.element.get", {
        IBLOCK_TYPE_ID: "lists",
        IBLOCK_ID: schema.lists.categories
      });
      const cf = schema.fields.categories;
      const normalized = existingCategories.map(row => ({
        name: String(row.NAME || "").trim().toLowerCase(),
        type: propOne(row, cf.TYPE)
      }));

      onProgress("Проверяю обязательные статьи…");
      for (const category of REQUIRED_CATEGORIES) {
        const exists = normalized.some(c =>
          c.type === category.type && c.name === category.name.trim().toLowerCase()
        );
        if (!exists) await this.addCategory(schema, category);
      }

      return schema;
    }

    async load(schema) {
      const [projectsRaw, categoriesRaw, operationsRaw] = await Promise.all([
        api.all("lists.element.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.projects,
          ELEMENT_ORDER: { ID: "desc" }
        }),
        api.all("lists.element.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.categories,
          ELEMENT_ORDER: { ID: "asc" }
        }),
        api.all("lists.element.get", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.operations,
          ELEMENT_ORDER: { ID: "desc" }
        })
      ]);

      const pf = schema.fields.projects;
      const cf = schema.fields.categories;
      const of = schema.fields.operations;

      state.projects = projectsRaw.map(row => ({
        id: String(row.ID),
        name: row.NAME,
        members: propValues(row, pf.MEMBERS)
      }));

      state.categories = categoriesRaw.map(row => ({
        id: String(row.ID),
        name: row.NAME,
        type: propOne(row, cf.TYPE),
        system: propOne(row, cf.SYSTEM) === "Y"
      }));

      state.operations = operationsRaw.map(row => ({
        id: String(row.ID),
        name: row.NAME,
        projectId: propOne(row, of.PROJECT_ID),
        type: propOne(row, of.TYPE),
        categoryId: propOne(row, of.CATEGORY_ID),
        amountCents: Number(propOne(row, of.AMOUNT_CENTS) || 0),
        date: normalizeDate(propOne(row, of.OP_DATE)),
        comment: propOne(row, of.COMMENT),
        createdBy: String(row.CREATED_BY || "")
      }));

      await this.loadUsers();
    }

    async loadUsers() {
      try {
        const rows = await api.all("user.get", { FILTER: { ACTIVE: true } });
        rows.forEach(u => state.users.set(String(u.ID), [u.NAME, u.LAST_NAME].filter(Boolean).join(" ")));
      } catch (e) {
        console.warn("Не удалось загрузить пользователей:", e);
      }
    }

    async saveProject(schema, project) {
      const fields = { NAME: project.name };
      fields[schema.fields.projects.MEMBERS] = project.members;

      if (project.id) {
        await api.call("lists.element.update", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.projects,
          ELEMENT_ID: project.id,
          FIELDS: fields
        });
      } else {
        await api.call("lists.element.add", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.projects,
          ELEMENT_CODE: code("project"),
          FIELDS: fields
        });
      }
    }

    async deleteProject(schema, id) {
      const hasOperations = state.operations.some(o => o.projectId === String(id));
      if (hasOperations) throw new Error("Сначала удалите операции этого проекта");
      await api.call("lists.element.delete", {
        IBLOCK_TYPE_ID: "lists",
        IBLOCK_ID: schema.lists.projects,
        ELEMENT_ID: id
      });
    }

    async saveOperation(schema, operation) {
      const of = schema.fields.operations;
      const fields = { NAME: `${operation.type === "income" ? "Доход" : "Расход"} · ${operation.date}` };
      fields[of.PROJECT_ID] = operation.projectId;
      fields[of.TYPE] = operation.type;
      fields[of.CATEGORY_ID] = operation.categoryId;
      fields[of.AMOUNT_CENTS] = operation.amountCents;
      fields[of.OP_DATE] = operation.date;
      fields[of.COMMENT] = operation.comment;

      if (operation.id) {
        await api.call("lists.element.update", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.operations,
          ELEMENT_ID: operation.id,
          FIELDS: fields
        });
      } else {
        await api.call("lists.element.add", {
          IBLOCK_TYPE_ID: "lists",
          IBLOCK_ID: schema.lists.operations,
          ELEMENT_CODE: code("operation"),
          FIELDS: fields
        });
      }
    }

    async deleteOperation(schema, id) {
      await api.call("lists.element.delete", {
        IBLOCK_TYPE_ID: "lists",
        IBLOCK_ID: schema.lists.operations,
        ELEMENT_ID: id
      });
    }

    async addCategory(schema, category) {
      const cf = schema.fields.categories;
      const fields = { NAME: category.name };
      fields[cf.TYPE] = category.type;
      fields[cf.SYSTEM] = category.system ? "Y" : "N";
      await api.call("lists.element.add", {
        IBLOCK_TYPE_ID: "lists",
        IBLOCK_ID: schema.lists.categories,
        ELEMENT_CODE: code("category"),
        FIELDS: fields
      });
    }

    async deleteCategory(schema, id) {
      const category = state.categories.find(c => c.id === String(id));
      if (!category) return;
      if (category.system) throw new Error("Системную статью удалить нельзя");
      if (state.operations.some(o => o.categoryId === String(id))) {
        throw new Error("Статья уже используется в операциях");
      }
      await api.call("lists.element.delete", {
        IBLOCK_TYPE_ID: "lists",
        IBLOCK_ID: schema.lists.categories,
        ELEMENT_ID: id
      });
    }
  }

  class MockStorage {
    constructor() {
      this.key = "bitrix24-project-finance-demo-v1";
    }

    seed() {
      const data = {
        projects: [
          { id: "1", name: "Корпоративный сайт", members: ["11", "12"] },
          { id: "2", name: "CRM-интеграция", members: ["12", "13", "14"] },
          { id: "3", name: "AI-ассистент поддержки", members: ["11", "13"] }
        ],
        categories: REQUIRED_CATEGORIES.map((c, i) => ({ id: String(i + 1), ...c })),
        operations: [
          { id: "101", projectId: "1", type: "income", categoryId: "1", amountCents: 48000000, date: "2026-08-29", comment: "Первый этап" },
          { id: "102", projectId: "1", type: "expense", categoryId: "2", amountCents: 12000000, date: "2026-08-30", comment: "Frontend" },
          { id: "103", projectId: "1", type: "expense", categoryId: "4", amountCents: 245000, date: "2026-09-01", comment: "AI-код-ревью" },
          { id: "104", projectId: "2", type: "income", categoryId: "1", amountCents: 75000000, date: "2026-09-02", comment: "Внедрение" },
          { id: "105", projectId: "2", type: "expense", categoryId: "3", amountCents: 21000000, date: "2026-09-03", comment: "Команда разработки" },
          { id: "106", projectId: "2", type: "expense", categoryId: "5", amountCents: 390000, date: "2026-09-03", comment: "VPS" },
          { id: "107", projectId: "3", type: "income", categoryId: "1", amountCents: 31000000, date: "2026-09-05", comment: "MVP" },
          { id: "108", projectId: "3", type: "expense", categoryId: "4", amountCents: 6700000, date: "2026-09-06", comment: "API и модели" }
        ]
      };
      localStorage.setItem(this.key, JSON.stringify(data));
      return data;
    }

    data() {
      try { return JSON.parse(localStorage.getItem(this.key)) || this.seed(); }
      catch { return this.seed(); }
    }

    save(data) { localStorage.setItem(this.key, JSON.stringify(data)); }

    async discover() { return { mock: true }; }
    async setup() { return { mock: true }; }

    async load() {
      const data = this.data();
      state.projects = data.projects;
      state.categories = data.categories;
      state.operations = data.operations;
      MOCK_USERS.forEach(u => state.users.set(u.id, u.name));
    }

    nextId(rows) {
      return String(Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1);
    }

    async saveProject(_, project) {
      const data = this.data();
      if (project.id) {
        data.projects = data.projects.map(p => p.id === project.id ? { ...p, ...project } : p);
      } else {
        project.id = this.nextId(data.projects);
        data.projects.unshift(project);
      }
      this.save(data);
    }

    async deleteProject(_, id) {
      const data = this.data();
      if (data.operations.some(o => o.projectId === String(id))) throw new Error("Сначала удалите операции этого проекта");
      data.projects = data.projects.filter(p => p.id !== String(id));
      this.save(data);
    }

    async saveOperation(_, operation) {
      const data = this.data();
      if (operation.id) {
        data.operations = data.operations.map(o => o.id === operation.id ? { ...o, ...operation } : o);
      } else {
        operation.id = this.nextId(data.operations);
        data.operations.unshift(operation);
      }
      this.save(data);
    }

    async deleteOperation(_, id) {
      const data = this.data();
      data.operations = data.operations.filter(o => o.id !== String(id));
      this.save(data);
    }

    async addCategory(_, category) {
      const data = this.data();
      category.id = this.nextId(data.categories);
      data.categories.push(category);
      this.save(data);
    }

    async deleteCategory(_, id) {
      const data = this.data();
      const category = data.categories.find(c => c.id === String(id));
      if (category?.system) throw new Error("Системную статью удалить нельзя");
      if (data.operations.some(o => o.categoryId === String(id))) throw new Error("Статья уже используется в операциях");
      data.categories = data.categories.filter(c => c.id !== String(id));
      this.save(data);
    }
  }

  const storage = state.mode === "bitrix" ? new BitrixStorage() : new MockStorage();

  async function reloadData() {
    await storage.load(state.schema);
    render();
  }

  function projectMetrics(projectId) {
    return F.calcMetrics(state.operations.filter(o => o.projectId === String(projectId)));
  }

  function projectName(id) {
    return state.projects.find(p => p.id === String(id))?.name || `Проект #${id}`;
  }

  function categoryName(id) {
    return state.categories.find(c => c.id === String(id))?.name || `Статья #${id}`;
  }

  function userName(id) {
    return state.users.get(String(id)) || `Сотрудник #${id}`;
  }

  function renderSummary() {
    const m = F.calcMetrics(state.operations);
    $("totalIncome").textContent = F.formatMoney(m.incomeCents);
    $("totalExpense").textContent = F.formatMoney(m.expenseCents);
    $("totalProfit").textContent = F.formatMoney(m.profitCents);
    $("totalProfit").className = m.profitCents >= 0 ? "value-positive" : "value-negative";
    $("totalMargin").textContent = F.formatPercent(m.marginPct);
    $("totalMargin").className = m.marginPct !== null && m.marginPct >= 0 ? "value-positive" : "value-negative";
  }

  function renderProjects() {
    const search = $("projectSearch").value.trim().toLowerCase();
    const projects = state.projects.filter(p => p.name.toLowerCase().includes(search));
    $("projectsEmpty").classList.toggle("hidden", projects.length !== 0);

    $("projectGrid").innerHTML = projects.map(project => {
      const m = projectMetrics(project.id);
      const members = project.members.map(userName).join(", ") || "Не назначены";
      return `
        <article class="project-card">
          <div class="project-card-head">
            <h3>${escapeHtml(project.name)}</h3>
            <div class="project-actions">
              <button class="icon-btn edit-project" data-id="${project.id}" title="Редактировать">✎</button>
              <button class="icon-btn delete-project" data-id="${project.id}" title="Удалить">×</button>
            </div>
          </div>
          <div class="project-metrics">
            <div class="project-stat"><span>Доходы</span><strong>${F.formatMoney(m.incomeCents)}</strong></div>
            <div class="project-stat"><span>Расходы</span><strong>${F.formatMoney(m.expenseCents)}</strong></div>
            <div class="project-stat"><span>Прибыль</span><strong class="${m.profitCents >= 0 ? "value-positive" : "value-negative"}">${F.formatMoney(m.profitCents)}</strong></div>
            <div class="project-stat"><span>Рентабельность</span><strong class="${m.marginPct !== null && m.marginPct >= 0 ? "value-positive" : "value-negative"}">${F.formatPercent(m.marginPct)}</strong></div>
          </div>
          <div class="team-line">
            <span>Команда</span>
            <div class="team-names">${escapeHtml(members)}</div>
          </div>
        </article>`;
    }).join("");
  }

  function renderOperations() {
    const projectFilter = $("operationProjectFilter").value;
    const typeFilter = $("operationTypeFilter").value;

    const rows = [...state.operations]
      .filter(o => !projectFilter || o.projectId === projectFilter)
      .filter(o => !typeFilter || o.type === typeFilter)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || Number(b.id) - Number(a.id));

    $("operationsEmpty").classList.toggle("hidden", rows.length !== 0);
    $("operationsBody").innerHTML = rows.map(o => `
      <tr>
        <td>${formatDate(o.date)}</td>
        <td>${escapeHtml(projectName(o.projectId))}</td>
        <td><span class="type-pill ${o.type}">${o.type === "income" ? "Доход" : "Расход"}</span></td>
        <td>${escapeHtml(categoryName(o.categoryId))}</td>
        <td>${escapeHtml(o.comment || "—")}</td>
        <td class="amount-cell ${o.type === "income" ? "value-positive" : "value-negative"}">${o.type === "income" ? "+" : "−"}${F.formatMoney(o.amountCents)}</td>
        <td>
          <button class="icon-btn edit-operation" data-id="${o.id}" title="Редактировать">✎</button>
          <button class="icon-btn delete-operation" data-id="${o.id}" title="Удалить">×</button>
        </td>
      </tr>
    `).join("");
  }

  function renderCategories() {
    const renderList = (type) => state.categories.filter(c => c.type === type).map(c => `
      <div class="category-item">
        <span class="category-item-name">${escapeHtml(c.name)}</span>
        <span class="category-item-actions">
          ${c.system ? '<span class="system-pill">системная</span>' : `<button class="icon-btn delete-category" data-id="${c.id}" title="Удалить">×</button>`}
        </span>
      </div>`).join("");

    $("incomeCategories").innerHTML = renderList("income");
    $("expenseCategories").innerHTML = renderList("expense");
  }

  function renderSelects() {
    const currentFilter = $("operationProjectFilter").value;
    $("operationProjectFilter").innerHTML = `<option value="">Все проекты</option>` +
      state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    $("operationProjectFilter").value = state.projects.some(p => p.id === currentFilter) ? currentFilter : "";

    $("operationProject").innerHTML = state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    renderOperationCategories();
  }

  function renderOperationCategories() {
    const type = $("operationType").value;
    const current = $("operationCategory").value;
    const categories = state.categories.filter(c => c.type === type);
    $("operationCategory").innerHTML = categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    if (categories.some(c => c.id === current)) $("operationCategory").value = current;
  }

  function renderMemberChips() {
    $("memberChips").innerHTML = state.selectedMembers.map(m => `
      <span class="chip">${escapeHtml(m.name)}
        <button type="button" class="remove-member" data-id="${m.id}" aria-label="Удалить">×</button>
      </span>`).join("");
  }

  function render() {
    renderSummary();
    renderProjects();
    renderSelects();
    renderOperations();
    renderCategories();
  }

  function showMain() {
    $("setupScreen").classList.add("hidden");
    $("mainScreen").classList.remove("hidden");
  }

  function showSetup() {
    $("mainScreen").classList.add("hidden");
    $("setupScreen").classList.remove("hidden");
  }

  function switchTab(name) {
    qsa(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
    ["projects", "operations", "categories"].forEach(tab => {
      $(`${tab}Tab`).classList.toggle("hidden", tab !== name);
    });
  }

  async function chooseMembers() {
    if (state.mode === "bitrix") {
      BX24.selectUsers((users) => {
        const existing = new Map(state.selectedMembers.map(m => [String(m.id), m]));
        (users || []).forEach(u => existing.set(String(u.id), { id: String(u.id), name: u.name }));
        state.selectedMembers = [...existing.values()];
        renderMemberChips();
      });
      return;
    }

    $("mockUserList").innerHTML = MOCK_USERS.map(u => {
      const checked = state.selectedMembers.some(m => m.id === u.id) ? "checked" : "";
      return `<label class="mock-user"><input type="checkbox" value="${u.id}" ${checked}><span>${escapeHtml(u.name)}</span></label>`;
    }).join("");
    openModal("mockUserModal");
  }

  function newProject(project = null) {
    $("projectForm").reset();
    $("projectId").value = project?.id || "";
    $("projectName").value = project?.name || "";
    $("projectModalTitle").textContent = project ? "Редактировать проект" : "Новый проект";
    state.selectedMembers = (project?.members || []).map(id => ({ id, name: userName(id) }));
    renderMemberChips();
    openModal("projectModal");
  }

  function newOperation(operation = null) {
    if (state.projects.length === 0) {
      toast("Сначала создайте проект");
      return;
    }
    $("operationForm").reset();
    $("operationId").value = operation?.id || "";
    $("operationModalTitle").textContent = operation ? "Редактировать операцию" : "Новая операция";
    $("operationDate").value = operation?.date || dateToday();
    $("operationType").value = operation?.type || "income";
    renderSelects();
    if (operation) {
      $("operationProject").value = operation.projectId;
      $("operationType").value = operation.type;
      renderOperationCategories();
      $("operationCategory").value = operation.categoryId;
      $("operationAmount").value = (operation.amountCents / 100).toFixed(2).replace(".", ",");
      $("operationComment").value = operation.comment || "";
    }
    openModal("operationModal");
  }

  async function bootstrap() {
    $("modeBadge").textContent = state.mode === "bitrix" ? "Битрикс24" : "Демо-режим";
    $("modeBadge").classList.add(state.mode === "bitrix" ? "bitrix" : "demo");

    if (state.mode === "bitrix") {
      await api.init();
      try {
        const current = await api.call("user.current");
        state.currentUser = current.data;
        const name = [current.data.NAME, current.data.LAST_NAME].filter(Boolean).join(" ");
        $("userBadge").textContent = name || `Сотрудник #${current.data.ID}`;
        state.users.set(String(current.data.ID), name);
      } catch {
        $("userBadge").textContent = "Сотрудник Битрикс24";
      }
    } else {
      state.currentUser = { ID: "11", NAME: "Анна", LAST_NAME: "Смирнова" };
      $("userBadge").textContent = "Анна Смирнова";
    }

    try {
      state.schema = await storage.discover();
      if (!state.schema) {
        showSetup();
        return;
      }
      await reloadData();
      showMain();
    } catch (e) {
      console.error(e);
      showSetup();
      $("setupProgress").textContent = `Ошибка: ${e.message}`;
    }
  }

  $("setupBtn").addEventListener("click", async () => {
    const btn = $("setupBtn");
    btn.disabled = true;
    $("setupProgress").textContent = "";
    try {
      state.schema = await storage.setup(msg => $("setupProgress").textContent = msg);
      await reloadData();
      showMain();
      toast("Приложение готово к работе");
    } catch (e) {
      console.error(e);
      $("setupProgress").textContent = `Не удалось выполнить настройку.\n${e.message}\nПроверьте, что приложение открыто администратором и имеет права «Списки» и «Пользователи (базовые)».`;
    } finally {
      btn.disabled = false;
    }
  });

  qsa(".tab").forEach(tab => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  qsa("[data-close]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.close)));

  qsa(".modal-backdrop").forEach(backdrop => backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal(backdrop.id);
  }));

  $("addProjectBtn").addEventListener("click", () => newProject());
  $("addOperationBtn").addEventListener("click", () => newOperation());
  $("addCategoryBtn").addEventListener("click", () => {
    $("categoryForm").reset();
    openModal("categoryModal");
  });
  $("selectMembersBtn").addEventListener("click", chooseMembers);
  $("operationType").addEventListener("change", renderOperationCategories);
  $("projectSearch").addEventListener("input", renderProjects);
  $("operationProjectFilter").addEventListener("change", renderOperations);
  $("operationTypeFilter").addEventListener("change", renderOperations);

  $("memberChips").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove-member");
    if (!btn) return;
    state.selectedMembers = state.selectedMembers.filter(m => m.id !== btn.dataset.id);
    renderMemberChips();
  });

  $("applyMockUsersBtn").addEventListener("click", () => {
    const ids = [...$("mockUserList").querySelectorAll('input[type="checkbox"]:checked')].map(x => x.value);
    state.selectedMembers = MOCK_USERS.filter(u => ids.includes(u.id));
    renderMemberChips();
    closeModal("mockUserModal");
  });

  $("projectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const project = {
      id: $("projectId").value || null,
      name: $("projectName").value.trim(),
      members: state.selectedMembers.map(m => String(m.id))
    };
    if (!project.name) return;
    try {
      await storage.saveProject(state.schema, project);
      await reloadData();
      closeModal("projectModal");
      toast(project.id ? "Проект обновлён" : "Проект создан");
    } catch (err) { toast(err.message); }
  });

  $("operationForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const amountCents = F.toCents($("operationAmount").value);
      if (!isSafePositiveCents(amountCents)) throw new Error("Сумма должна быть больше нуля");
      const operation = {
        id: $("operationId").value || null,
        projectId: $("operationProject").value,
        type: $("operationType").value,
        categoryId: $("operationCategory").value,
        amountCents,
        date: $("operationDate").value,
        comment: $("operationComment").value.trim()
      };
      if (!operation.projectId || !operation.categoryId || !operation.date) throw new Error("Заполните обязательные поля");
      const category = state.categories.find(c => c.id === operation.categoryId);
      if (!category || category.type !== operation.type) throw new Error("Статья не соответствует типу операции");

      await storage.saveOperation(state.schema, operation);
      await reloadData();
      closeModal("operationModal");
      toast(operation.id ? "Операция обновлена" : "Операция добавлена");
    } catch (err) { toast(err.message); }
  });

  $("categoryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const category = {
      name: $("categoryName").value.trim(),
      type: $("categoryType").value,
      system: false
    };
    if (!category.name) return;
    if (state.categories.some(c => c.type === category.type && c.name.toLowerCase() === category.name.toLowerCase())) {
      toast("Такая статья уже существует");
      return;
    }
    try {
      await storage.addCategory(state.schema, category);
      await reloadData();
      closeModal("categoryModal");
      toast("Статья добавлена");
    } catch (err) { toast(err.message); }
  });

  $("projectGrid").addEventListener("click", async (e) => {
    const edit = e.target.closest(".edit-project");
    const del = e.target.closest(".delete-project");
    if (edit) {
      const project = state.projects.find(p => p.id === edit.dataset.id);
      if (project) newProject(project);
    }
    if (del) {
      const project = state.projects.find(p => p.id === del.dataset.id);
      if (!project || !confirm(`Удалить проект «${project.name}»?`)) return;
      try {
        await storage.deleteProject(state.schema, project.id);
        await reloadData();
        toast("Проект удалён");
      } catch (err) { toast(err.message); }
    }
  });

  $("operationsBody").addEventListener("click", async (e) => {
    const edit = e.target.closest(".edit-operation");
    const del = e.target.closest(".delete-operation");
    if (edit) {
      const operation = state.operations.find(o => o.id === edit.dataset.id);
      if (operation) newOperation(operation);
    }
    if (del) {
      if (!confirm("Удалить финансовую операцию?")) return;
      try {
        await storage.deleteOperation(state.schema, del.dataset.id);
        await reloadData();
        toast("Операция удалена");
      } catch (err) { toast(err.message); }
    }
  });

  $("categoriesTab").addEventListener("click", async (e) => {
    const del = e.target.closest(".delete-category");
    if (!del || !confirm("Удалить пользовательскую статью?")) return;
    try {
      await storage.deleteCategory(state.schema, del.dataset.id);
      await reloadData();
      toast("Статья удалена");
    } catch (err) { toast(err.message); }
  });

  bootstrap();
})();

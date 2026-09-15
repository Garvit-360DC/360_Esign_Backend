import {
  compositeCreate,
  deleteRecord,
  ns,
  soql,
  soqlEscape,
  updateRecord,
  type CompositeEntry,
  type OrgDetails,
} from "../../integrations/salesforce";
import { AppError } from "../../utils/appError";
import { isSignFieldType, isSignerRole } from "../sign-requests/sign-request.types";
import type {
  CreateTemplateInput,
  Template,
  TemplateField,
  TemplateRecipient,
  TemplateSummary,
} from "./template.types";

/**
 * Reads and writes templates in Salesforce.
 *
 * Field names go through `ns()` so a packaged install with a namespace works without code
 * changes. SOQL is assembled with those same names rather than hardcoded strings, which is
 * verbose but means a rename shows up in one place.
 */

const TEMPLATE = () => ns("eSign_Template__c");
const RECIPIENT = () => ns("eSign_Template_Recipient__c");
const FIELD = () => ns("eSign_Template_Field__c");

/** A row as Salesforce returns it: namespaced keys, everything nullable. */
type Row = Record<string, unknown>;

function str(row: Row, name: string): string | null {
  const value = row[ns(name)];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(row: Row, name: string): number | null {
  const value = row[ns(name)];
  return typeof value === "number" ? value : null;
}

function bool(row: Row, name: string): boolean {
  return row[ns(name)] === true;
}

const TEMPLATE_FIELDS = () =>
  [
    "Id",
    "Name",
    ns("Description__c"),
    ns("SObject_Name__c"),
    ns("Document_Version_Id__c"),
    ns("Document_Name__c"),
    ns("Page_Count__c"),
    ns("Is_Active__c"),
    ns("Email_Subject__c"),
    ns("Email_Message__c"),
    ns("Signing_Order__c"),
    ns("Expires_In_Days__c"),
    ns("Reminder_Days__c"),
    ns("Template_Key__c"),
  ].join(", ");

function toRecipient(row: Row): TemplateRecipient | null {
  const role = str(row, "Role__c");
  // A recipient with no slot cannot be sent to. Skip it rather than emit an invalid role and
  // have the send fail later with a message about validation.
  if (!role || !isSignerRole(role)) return null;

  return {
    id: String(row.Id),
    role,
    recipientType: str(row, "Recipient_Type__c") === "CC" ? "CC" : "SIGNER",
    label: str(row, "Label__c"),
    order: num(row, "Order__c") ?? 0,
    defaultName: str(row, "Default_Name__c"),
    defaultEmail: str(row, "Default_Email__c"),
  };
}

function toField(row: Row): TemplateField | null {
  // Role__c is a formula reading through the Recipient lookup, so it is blank when that
  // lookup was cleared — which happens if the recipient was deleted out from under it.
  const role = str(row, "Role__c");
  const type = str(row, "Field_Type__c");
  if (!role || !isSignerRole(role) || !type || !isSignFieldType(type)) return null;

  const rect = {
    x: num(row, "Position_X__c") ?? 0,
    y: num(row, "Position_Y__c") ?? 0,
    width: num(row, "Width__c") ?? 0,
    height: num(row, "Height__c") ?? 0,
  };

  if (rect.width <= 0 || rect.height <= 0) return null;

  const source = str(row, "Source__c");

  return {
    id: String(row.Id),
    role,
    recipientId: str(row, "Recipient__c"),
    type,
    page: num(row, "Page__c") ?? 1,
    rect,
    source: source === "image" || source === "text" ? source : "manual",
    required: bool(row, "Required__c"),
  };
}

function toTemplate(row: Row, recipients: Row[], fields: Row[]): Template {
  const order = str(row, "Signing_Order__c");

  return {
    id: String(row.Id),
    key: str(row, "Template_Key__c") ?? String(row.Id),
    name: String(row.Name ?? "Untitled template"),
    description: str(row, "Description__c"),
    sObjectName: str(row, "SObject_Name__c"),
    documentVersionId: str(row, "Document_Version_Id__c") ?? "",
    documentName: str(row, "Document_Name__c"),
    pageCount: num(row, "Page_Count__c"),
    isActive: bool(row, "Is_Active__c"),
    emailSubject: str(row, "Email_Subject__c"),
    emailMessage: str(row, "Email_Message__c"),
    signingOrder: order === "Sequential" ? "Sequential" : "Parallel",
    expiresInDays: num(row, "Expires_In_Days__c"),
    reminderDays: str(row, "Reminder_Days__c"),
    recipients: recipients
      .map(toRecipient)
      .filter((entry): entry is TemplateRecipient => entry !== null)
      .sort((a, b) => a.order - b.order),
    fields: fields.map(toField).filter((entry): entry is TemplateField => entry !== null),
  };
}

export async function listTemplates(
  session: OrgDetails,
  options: { sObjectName?: string; includeInactive?: boolean } = {}
): Promise<TemplateSummary[]> {
  const where: string[] = [];
  if (!options.includeInactive) where.push(`${ns("Is_Active__c")} = true`);
  if (options.sObjectName) {
    where.push(`${ns("SObject_Name__c")} = '${soqlEscape(options.sObjectName)}'`);
  }

  const rows = await soql<Row>(
    session,
    `SELECT ${TEMPLATE_FIELDS()} FROM ${TEMPLATE()}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY Name`
  );

  if (rows.length === 0) return [];

  // Counted with an aggregate rather than a subquery: a subquery returns at most 200 child
  // rows per parent, so a long document's boxes would be undercounted without any error.
  const [recipientCounts, fieldCounts] = await Promise.all([
    countByTemplate(session, RECIPIENT()),
    countByTemplate(session, FIELD()),
  ]);

  return rows.map((row) => {
    const id = String(row.Id);

    return {
      id,
      key: str(row, "Template_Key__c") ?? id,
      name: String(row.Name ?? "Untitled template"),
      description: str(row, "Description__c"),
      sObjectName: str(row, "SObject_Name__c"),
      documentName: str(row, "Document_Name__c"),
      pageCount: num(row, "Page_Count__c"),
      isActive: bool(row, "Is_Active__c"),
      recipientCount: recipientCounts.get(id) ?? 0,
      fieldCount: fieldCounts.get(id) ?? 0,
    };
  });
}

async function countByTemplate(
  session: OrgDetails,
  objectName: string
): Promise<Map<string, number>> {
  const rows = await soql<{ tid: string; total: number }>(
    session,
    `SELECT ${ns("Template__c")} tid, COUNT(Id) total FROM ${objectName}
     GROUP BY ${ns("Template__c")}`
  );

  return new Map(rows.map((row) => [row.tid, row.total]));
}

/**
 * One template with its recipients and boxes.
 *
 * Three queries rather than one with subqueries: a subquery caps at 200 rows per parent, and
 * a long document can carry more boxes than that.
 */
export async function findTemplateByKey(
  session: OrgDetails,
  key: string
): Promise<Template | null> {
  const [row] = await soql<Row>(
    session,
    `SELECT ${TEMPLATE_FIELDS()} FROM ${TEMPLATE()}
     WHERE ${ns("Template_Key__c")} = '${soqlEscape(key)}' LIMIT 1`
  );

  if (!row) return null;

  const templateId = String(row.Id);

  const [recipients, fields] = await Promise.all([
    soql<Row>(
      session,
      `SELECT Id, ${ns("Role__c")}, ${ns("Recipient_Type__c")}, ${ns("Label__c")},
              ${ns("Order__c")}, ${ns("Default_Name__c")}, ${ns("Default_Email__c")}
       FROM ${RECIPIENT()} WHERE ${ns("Template__c")} = '${templateId}' ORDER BY ${ns("Order__c")}`
    ),
    soql<Row>(
      session,
      `SELECT Id, ${ns("Role__c")}, ${ns("Recipient__c")}, ${ns("Field_Type__c")},
              ${ns("Page__c")}, ${ns("Position_X__c")}, ${ns("Position_Y__c")},
              ${ns("Width__c")}, ${ns("Height__c")}, ${ns("Source__c")}, ${ns("Required__c")}
       FROM ${FIELD()} WHERE ${ns("Template__c")} = '${templateId}'
       ORDER BY ${ns("Page__c")}, ${ns("Position_Y__c")}`
    ),
  ]);

  return toTemplate(row, recipients, fields);
}

/**
 * Writes a template, its recipients and its boxes.
 *
 * The parent and recipients go in one composite call so the boxes can reference the
 * recipient ids it returns. Boxes follow in batches, because composite takes 25 subrequests
 * at a time and a template can hold far more than 25.
 */
export async function createTemplate(
  session: OrgDetails,
  key: string,
  input: CreateTemplateInput,
  document: { contentVersionId: string; fileName: string; pageCount: number }
): Promise<string> {
  const header: CompositeEntry[] = [
    {
      referenceId: "template",
      objectName: TEMPLATE(),
      values: {
        Name: input.name,
        [ns("Template_Key__c")]: key,
        [ns("Description__c")]: input.description ?? null,
        [ns("SObject_Name__c")]: input.sObjectName ?? null,
        [ns("Document_Version_Id__c")]: document.contentVersionId,
        [ns("Document_Name__c")]: document.fileName,
        [ns("Page_Count__c")]: document.pageCount,
        [ns("Is_Active__c")]: true,
        [ns("Email_Subject__c")]: input.emailSubject ?? null,
        [ns("Email_Message__c")]: input.emailMessage ?? null,
        [ns("Signing_Order__c")]: input.signingOrder ?? "Parallel",
        [ns("Expires_In_Days__c")]: input.expiresInDays ?? null,
        [ns("Reminder_Days__c")]: input.reminderDays ?? null,
      },
    },
    ...input.recipients.map((recipient, index) => ({
      referenceId: `recipient${index}`,
      objectName: RECIPIENT(),
      values: {
        [ns("Template__c")]: "@{template.id}",
        [ns("Role__c")]: recipient.role,
        [ns("Recipient_Type__c")]: recipient.recipientType ?? "SIGNER",
        [ns("Label__c")]: recipient.label ?? null,
        [ns("Order__c")]: recipient.order ?? index + 1,
        [ns("Default_Name__c")]: recipient.defaultName ?? null,
        [ns("Default_Email__c")]: recipient.defaultEmail ?? null,
      },
    })),
  ];

  const ids = await compositeCreate(session, header);
  const templateId = ids.template;

  if (!templateId) {
    throw new AppError("Salesforce did not return the new template.", 502, "SALESFORCE_ERROR");
  }

  const recipientIdByRole = new Map<string, string>();
  input.recipients.forEach((recipient, index) => {
    const id = ids[`recipient${index}`];
    if (id) recipientIdByRole.set(recipient.role, id);
  });

  const boxes: CompositeEntry[] = input.fields.map((field, index) => ({
    referenceId: `field${index}`,
    objectName: FIELD(),
    values: {
      [ns("Template__c")]: templateId,
      [ns("Recipient__c")]: recipientIdByRole.get(field.role) ?? null,
      [ns("Field_Type__c")]: field.type,
      [ns("Page__c")]: field.page,
      [ns("Position_X__c")]: field.rect.x,
      [ns("Position_Y__c")]: field.rect.y,
      [ns("Width__c")]: field.rect.width,
      [ns("Height__c")]: field.rect.height,
      [ns("Source__c")]: field.source ?? "manual",
      [ns("Required__c")]: field.required ?? true,
    },
  }));

  // Composite allows 25 subrequests; the header call already used one per recipient.
  const BATCH = 25;
  try {
    for (let start = 0; start < boxes.length; start += BATCH) {
      await compositeCreate(session, boxes.slice(start, start + BATCH));
    }
  } catch (error) {
    // The parent exists but its boxes do not, and a template with no boxes cannot be sent.
    // Remove it rather than leave something that looks usable in a list view.
    await deleteRecord(session, TEMPLATE(), templateId).catch(() => undefined);
    throw error;
  }

  return templateId;
}

/** Templates are deactivated rather than deleted, so sent envelopes keep their provenance. */
export async function deactivateTemplate(
  session: OrgDetails,
  templateId: string
): Promise<void> {
  await updateRecord(session, TEMPLATE(), templateId, { [ns("Is_Active__c")]: false });
}

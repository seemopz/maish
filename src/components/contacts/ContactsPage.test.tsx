import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ContactsPage, contactSubtitle } from "./ContactsPage";
import { getAllContacts, type DbContact } from "@/services/db/contacts";
import { getAddressBooksForAccount } from "@/services/db/addressBooks";
import { createDavContact, saveContact } from "@/services/contacts/contactActions";
import { useAccountStore } from "@/stores/accountStore";

vi.mock("@/services/db/contacts", () => ({ getAllContacts: vi.fn() }));
vi.mock("@/services/db/addressBooks", () => ({ getAddressBooksForAccount: vi.fn() }));
vi.mock("@/services/contacts/contactSync", () => ({
  CONTACTS_SYNC_DONE_EVENT: "maish-contacts-sync-done",
  syncContactsForAccount: vi.fn(),
}));
vi.mock("@/services/contacts/contactActions", () => ({
  createDavContact: vi.fn().mockResolvedValue("new-contact"),
  removeDavContact: vi.fn(),
  saveContact: vi.fn(),
}));

const contact = (overrides: Partial<DbContact> = {}): DbContact =>
  ({
    id: "c-1",
    email: "anna@example.org",
    display_name: "Anna Mustermann",
    avatar_url: null,
    frequency: 1,
    last_contacted_at: null,
    notes: null,
    source: "carddav",
    address_book_id: "book-1",
    dav_uid: "anna-1",
    dav_href: "https://dav.example.org/books/default/anna.vcf",
    dav_etag: "etag-1",
    vcard_data: "BEGIN:VCARD\r\nEND:VCARD",
    dav_emails: '["anna@example.org","zweit@example.net"]',
    dav_phones: '["+43 1 234"]',
    organization: "Beispiel GmbH",
    job_title: "Leiterin",
    ...overrides,
  }) as DbContact;

const book = (overrides: Record<string, unknown> = {}) => ({
  id: "book-1",
  account_id: "acc-1",
  provider: "carddav",
  remote_id: "https://dav.example.org/books/default/",
  display_name: "Kontakte",
  description: null,
  is_read_only: 0,
  is_visible: 1,
  sync_token: null,
  ctag: null,
  created_at: 0,
  updated_at: 0,
  ...overrides,
});

describe("ContactsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountStore.setState({
      accounts: [
        { id: "acc-1", email: "user@example.org", displayName: null, avatarUrl: null, isActive: true },
      ],
      activeAccountId: "acc-1",
    });
    vi.mocked(getAllContacts).mockResolvedValue([contact()]);
    vi.mocked(getAddressBooksForAccount).mockResolvedValue([book()] as never);
  });

  it("finds a contact beyond the first thousand", async () => {
    const many = Array.from({ length: 1500 }, (_, i) =>
      contact({ id: `c-${i}`, display_name: `Person ${i}`, email: `p${i}@example.org` }));
    vi.mocked(getAllContacts).mockImplementation(async (limit?: number | null) =>
      limit === null ? many : many.slice(0, limit ?? 500));
    render(<ContactsPage />);
    await screen.findByText("Person 0");

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "Person 1499" } });

    expect(await screen.findByText("Person 1499")).toBeInTheDocument();
  });

  it("draws a large list only in part and says so", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => contact({ id: `c-${i}`, display_name: `Person ${i}` }));
    vi.mocked(getAllContacts).mockResolvedValue(many);
    render(<ContactsPage />);

    expect(await screen.findByText(/showing 500 of 1,500/i)).toBeInTheDocument();
    expect(screen.queryByText("Person 1499")).not.toBeInTheDocument();
  });

  it("lists the contacts it loaded", async () => {
    render(<ContactsPage />);

    expect(await screen.findByText("Anna Mustermann")).toBeInTheDocument();
  });

  it("shows a contact's details once it is picked", async () => {
    render(<ContactsPage />);

    fireEvent.click(await screen.findByText("Anna Mustermann"));

    expect(await screen.findByText("Leiterin · Beispiel GmbH")).toBeInTheDocument();
    // Every address of the card, not just the one it is filed under.
    expect(screen.getByText("zweit@example.net")).toBeInTheDocument();
    expect(screen.getByText("+43 1 234")).toBeInTheDocument();
  });

  it("says where a contact came from", async () => {
    vi.mocked(getAllContacts).mockResolvedValue([
      contact({ id: "c-2", address_book_id: null, source: "local", display_name: "Bert Bauer" }),
    ]);
    render(<ContactsPage />);

    fireEvent.click(await screen.findByText("Bert Bauer"));

    expect(screen.getByText("Collected from your mail")).toBeInTheDocument();
  });

  it("filters the list by the search box", async () => {
    vi.mocked(getAllContacts).mockResolvedValue([
      contact(),
      contact({ id: "c-2", display_name: "Bert Bauer", email: "bert@example.org" }),
    ]);
    render(<ContactsPage />);

    fireEvent.change(await screen.findByLabelText("Search contacts"), { target: { value: "bert" } });

    expect(screen.getByText("Bert Bauer")).toBeInTheDocument();
    expect(screen.queryByText("Anna Mustermann")).not.toBeInTheDocument();
  });

  it("finds a contact by a secondary address", async () => {
    render(<ContactsPage />);

    fireEvent.change(await screen.findByLabelText("Search contacts"), { target: { value: "zweit@" } });

    expect(screen.getByText("Anna Mustermann")).toBeInTheDocument();
  });

  it("narrows the list to one address book", async () => {
    vi.mocked(getAllContacts).mockResolvedValue([
      contact(),
      contact({ id: "c-2", display_name: "Bert Bauer", address_book_id: null, source: "local" }),
    ]);
    render(<ContactsPage />);

    fireEvent.click(await screen.findByText("From mail"));

    expect(screen.getByText("Bert Bauer")).toBeInTheDocument();
    expect(screen.queryByText("Anna Mustermann")).not.toBeInTheDocument();
  });

  it("adds a contact to the first book that accepts writes", async () => {
    render(<ContactsPage />);

    fireEvent.click(await screen.findByLabelText("New contact"));

    await waitFor(() =>
      expect(createDavContact).toHaveBeenCalledWith("book-1", { displayName: "New contact" }),
    );
  });

  it("offers no new contact when every book is read-only", async () => {
    vi.mocked(getAddressBooksForAccount).mockResolvedValue([book({ is_read_only: 1 })] as never);
    render(<ContactsPage />);

    await waitFor(() => expect(screen.getByLabelText("New contact")).toBeDisabled());
  });

  it("hides the edit controls for a read-only book", async () => {
    vi.mocked(getAddressBooksForAccount).mockResolvedValue([book({ is_read_only: 1 })] as never);
    render(<ContactsPage />);

    fireEvent.click(await screen.findByText("Anna Mustermann"));

    expect(screen.queryByLabelText("Edit contact")).not.toBeInTheDocument();
  });

  it("saves an edit through the contact service", async () => {
    render(<ContactsPage />);

    fireEvent.click(await screen.findByText("Anna Mustermann"));
    fireEvent.click(screen.getByLabelText("Edit contact"));

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Anna M. Mustermann" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveContact).toHaveBeenCalledWith(
        expect.objectContaining({ id: "c-1" }),
        expect.objectContaining({ displayName: "Anna M. Mustermann" }),
      ),
    );
  });

  it("reports a refused save instead of pretending it worked", async () => {
    vi.mocked(saveContact).mockRejectedValue(new Error("it changed on the server"));
    render(<ContactsPage />);

    fireEvent.click(await screen.findByText("Anna Mustermann"));
    fireEvent.click(screen.getByLabelText("Edit contact"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("it changed on the server")).toBeInTheDocument();
  });
});

describe("contactSubtitle", () => {
  it("shows the address when there is one", () => {
    expect(contactSubtitle(contact())).toBe("anna@example.org");
  });

  it("falls back to the first phone number rather than claiming there is nothing", () => {
    expect(
      contactSubtitle(contact({ email: null, dav_phones: '["+43 664 1234567"]' })),
    ).toBe("+43 664 1234567");
  });

  it("falls back to the organisation when there is neither", () => {
    expect(
      contactSubtitle(contact({ email: null, dav_phones: "[]" })),
    ).toBe("Beispiel GmbH");
  });

  it("does not repeat the name when the organisation is the same", () => {
    expect(
      contactSubtitle(
        contact({
          email: null,
          dav_phones: "[]",
          display_name: "Dr. Primetshofer",
          organization: "Dr. Primetshofer",
        }),
      ),
    ).toBe("No address");
  });

  it("says so when the card really carries nothing to show", () => {
    expect(
      contactSubtitle(contact({ email: null, dav_phones: null, organization: null })),
    ).toBe("No address");
  });

  it("survives a malformed JSON column", () => {
    expect(
      contactSubtitle(contact({ email: null, dav_phones: "{kaputt", organization: null })),
    ).toBe("No address");
  });
});

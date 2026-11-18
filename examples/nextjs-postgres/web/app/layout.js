export const metadata = { title: "Notes" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "40rem" }}>
        {children}
      </body>
    </html>
  );
}

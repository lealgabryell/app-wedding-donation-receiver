// Messages of this class are shown to donors, so they must never contain provider data or secrets.
export class AppError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

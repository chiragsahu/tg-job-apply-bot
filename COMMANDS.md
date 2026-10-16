# 📖 Resume Bot — User Command Guide

A complete reference guide for all available Telegram commands in **Resume Bot**.

---

### 🚀 Getting Started & Account Overview

- **/start**  
  Displays the welcome message and checks your current configuration status.  
  Shows whether your email (SMTP), roles, resumes, and candidate profile are set up.

- **/help**  
  Opens the quick help manual listing all available commands and their categories.  
  Use this anytime you need a quick reminder of how to interact with the bot.

- **/profile**  
  Shows an overview of your entire account settings in one single dashboard.  
  Displays your connected SMTP email, active roles, default resume, and cover letter template preview.

---

### 📧 Email Configuration (SMTP)

- **/setup**  
  Starts the step-by-step setup wizard to connect your personal email account via SMTP.  
  Ensures all job application emails are sent securely directly from your own email address.

- **/delete_smtp**  
  Prompts for confirmation to remove your saved SMTP configuration from the database.  
  Use this if you change your email provider or need to update your email credentials.

---

### 👤 Candidate Screening Profile (Global Details)

- **/candidate_profile**  
  Displays your global candidate screening details like Official Name, DOB, Total Exp, CTC, and Notice Period.  
  Allows recruiters to instantly screen your core background metrics when viewing tailored emails.

- **/edit_profile**  
  Launches a guided questionnaire to fill or update your global candidate screening fields.  
  Supports skipping individual questions or updating details as your experience or notice period changes.

---

### 🎯 Job Roles & Multi-Resume Management (1:1 Resumes)

- **/roles**  
  Lists all your configured job roles along with their attached resumes and role-specific metrics.  
  Provides interactive buttons to add new roles or delete existing ones.

- **/add_role**  
  Creates a new role (e.g. `/add_role Senior Backend Engineer`) and sets its specific relevant experience and CTC expectations.  
  If you recently uploaded a PDF resume, it automatically attaches that resume to your newly created role.

- **/resume**  
  Shows the file name, upload date, and extracted word count of your default saved resume.  
  Provides an option to delete the default resume or replace it by sending a new PDF (max 3 MB).

- **/delete_resume**  
  Removes the default resume reference and parsed text from your account profile.  
  Allows you to clear out older default resumes without affecting role-specific attached resumes.

---

### 📝 Cover Letter Templates

- **/set_template**  
  Enters the cover letter template manager to define your desired tone, style, or personal intro notes.  
  The AI incorporates these guidelines into every cover email it drafts for you.

- **/view_template**  
  Displays your full saved cover letter guidelines and instructions currently stored in the system.  
  Includes quick inline buttons to edit or delete your existing template.

- **/delete_template**  
  Deletes your customized cover letter guidelines from your account.  
  Future applications will fall back to concise, professional industry-standard defaults.

---

### 📬 Job Applications & Bulk Emailing

- **/mail**  
  Enables bulk job applications to one or more recruiter emails (e.g. `/mail hr@apple.com, hr@google.com`).  
  Lets you pick which role's resume to attach, generates an AI-tailored application with screening metrics, and sends it from your SMTP.

- **/apply**  
  Starts a fast single-recipient application flow using your default resume.  
  Prompts for the job description and recruiter email, generates a tailored pitch, and sends it upon confirmation.

---

### ⚙️ Utility & Account Reset

- **/cancel**  
  Instantly cancels any ongoing conversation wizard or active setup flow.  
  Safely returns the bot to its ready state without modifying or saving partial input.

- **/reset**  
  Requests confirmation to permanently delete all your user data, SMTP credentials, roles, and profiles.  
  This action is irreversible and completely wipes your records from the database.

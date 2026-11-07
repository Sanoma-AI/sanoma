import { createFileRoute } from "@tanstack/react-router";
import { Link } from "sanoma/site";
import { CredentialsForm } from "../components/credentials-form.tsx";

export const Route = createFileRoute("/sites/account/sign-up")({ component: SignUp });

function SignUp() {
  return (
    <>
      <CredentialsForm route="sign-up/email" withName submit="Sign up" />
      <Link to="/sites/account/sign-in">Have an account? Sign in</Link>
    </>
  );
}
